# User Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user permanently delete their pwusage account from a dedicated `/account-delete` page, preserving shared Powerwall sites for remaining members and never stranding a Powerwall at a raised backup reserve.

**Spec:** [`docs/superpowers/specs/2026-11-08-user-account-deletion-design.md`](../specs/2026-11-08-user-account-deletion-design.md). Read it first.

**Architecture:** `DELETE /api/user` calls `deleteAccount` in `account-deletion-service.ts`, which restores any active Battery Saver session on sites where no other usable member remains, calls `AccountDeletionRepo.deleteAccount`, and then calls `siteRepo.repairConnection` for any surviving shared sites. The repo runs in one transaction: it locks `User` and the member's `Site` rows in deterministic `ORDER BY id` order, refuses if an unrestorable active `BatteryHold` or live `BatteryHoldStartClaim` would be stranded, removes the user's `MobileLoginHandoff`, `TrmnlInstallation` (`installed_by_user_id`), and `SiteMember` rows, deletes `EnergyDayArchive` and `Site` only for sites with no remaining `SiteMember` rows, and finally deletes `User`. The `/account-delete` page shows sole-member sites to be deleted, shared sites that will stay available to other members, and takes the typed confirmation. `/account-delete/done` offers optional Tesla removal.

**Tech Stack:** Next.js 16 App Router, TypeScript, PostgreSQL (`pg`), Tailwind CSS, Vitest 4.

## Global Constraints

- Run commands from `cmd/next-app`.
- **Never run deletion code or tests against `.env` or `DATABASE_URL`.** `.env` points at the Dev DB, and the Postgres suite uses a disposable local cluster on purpose. It needs PostgreSQL's `pg_config` on `PATH`.
- Use `npm run db:migration:create`. Never name a migration file by hand.
- Do not change `Site.user_id` back to `ON DELETE CASCADE` (`20261109135834_add_site_member.sql` set it to `ON DELETE SET NULL` so shared sites survive a connection user's deletion).
- Do not add `@testing-library/react` or jsdom. Component tests use `renderToStaticMarkup`.
- Do not add a Tesla revocation call or a challenge token. The spec explains why.
- No `any`. User-facing copy follows `docs/voice-and-terms.md`.

---

### Task 1: Migration and membership-aware transactional delete

**Files:**
- Create: `cmd/next-app/db-migrations/<generated>_user_account_deletion_cascades.sql`
- Create: `cmd/next-app/src/lib/account-deletion-repo.ts`
- Create: `cmd/next-app/src/lib/account-deletion-postgres.test.ts`
- Modify: `cmd/next-app/scripts/test-battery-hold.sh`

- [ ] **Step 1: Add the failing Postgres test to the disposable suite**

Create `cmd/next-app/src/lib/account-deletion-postgres.test.ts`:

```typescript
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: {
  query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
  connect: () => local.database.connect(),
} }));

import { AccountDeletionRepo, ActiveBatterySaverError } from './account-deletion-repo';
import { createActivityTestDatabase, safeActivityTestSocket as safeSocket } from './battery-hold-activity-test-db';

// Mirrors the production foreign keys for the tables this test creates by hand.
const TARIFF_TABLES = `
  CREATE TABLE "Tariff" (id serial PRIMARY KEY, site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE);
  CREATE TABLE "TariffSeason" (id serial PRIMARY KEY, tariff_id int NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE);
  CREATE TABLE "TariffSchedule" (id serial PRIMARY KEY, season_id int NOT NULL REFERENCES "TariffSeason"(id) ON DELETE CASCADE);`;
const ARCHIVE_TABLE = `
  CREATE TABLE "EnergyDayArchive" (
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE, day_start date NOT NULL, revision int NOT NULL,
    PRIMARY KEY (site_id, day_start, revision));`;
const OTHER_TABLES = `
  ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS refresh_token text,
    ADD COLUMN IF NOT EXISTS auth_status text,
    ADD COLUMN IF NOT EXISTS tesla_refresh_state text DEFAULT 'ready';
  ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Home',
    ADD COLUMN IF NOT EXISTS json jsonb;
  CREATE TABLE "EnergyDaySummary" (
    site_id text NOT NULL, day_start date NOT NULL, revision int NOT NULL,
    tariff_id int NOT NULL REFERENCES "Tariff"(id), tariff_schedule_id int REFERENCES "TariffSchedule"(id),
    FOREIGN KEY (site_id, day_start, revision) REFERENCES "EnergyDayArchive"(site_id, day_start, revision) ON DELETE CASCADE);
  CREATE TABLE "LoadTag" (id serial PRIMARY KEY, site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE);
  CREATE TABLE "TrmnlInstallation" (id serial PRIMARY KEY, site_id text NOT NULL);
  CREATE TABLE "MobileLoginHandoff" (id serial PRIMARY KEY, user_id text NOT NULL);
  CREATE TABLE "SystemAnnouncement" (id serial PRIMARY KEY, author_id text REFERENCES "User"(id));`;

async function applyMigrationsTwice(): Promise<void> {
  const siteMemberSql = await readFile('db-migrations/20261109135834_add_site_member.sql', 'utf8');
  await local.database.query(siteMemberSql);
  await local.database.query(siteMemberSql);

  const file = (await readdir('db-migrations')).find(name => name.endsWith('_user_account_deletion_cascades.sql'));
  if (!file) throw new Error('Migration not found');
  const sql = await readFile(`db-migrations/${file}`, 'utf8');
  await local.database.query(sql);
  await local.database.query(sql);
}

async function seedAccount(userId: string, siteId: string, name = 'Home'): Promise<void> {
  const db = local.database;
  await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES ($1, $2, \'active\')', [userId, `rt-${userId}`]);
  await db.query(
    'INSERT INTO "Site" (id, user_id, name, tesla_hardware_id, tesla_connection_user_id) VALUES ($1, $2, $3, $4, None)'
      .replace('None', 'NULL'),
    [siteId, userId, name, `hw-${siteId}`],
  );
  await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES ($1, $2, $1)', [siteId, userId]);
  await db.query('UPDATE "Site" SET tesla_connection_user_id = $1 WHERE id = $2', [userId, siteId]);
  const tariff = (await db.query('INSERT INTO "Tariff" (site_id) VALUES ($1) RETURNING id', [siteId])).rows[0].id;
  const season = (await db.query('INSERT INTO "TariffSeason" (tariff_id) VALUES ($1) RETURNING id', [tariff])).rows[0].id;
  const schedule = (await db.query('INSERT INTO "TariffSchedule" (season_id) VALUES ($1) RETURNING id', [season])).rows[0].id;
  await db.query(`INSERT INTO "EnergyDayArchive" VALUES ($1, '2026-01-01', 1)`, [siteId]);
  await db.query(`INSERT INTO "EnergyDaySummary" VALUES ($1, '2026-01-01', 1, $2, $3)`, [siteId, tariff, schedule]);
  await db.query('INSERT INTO "LoadTag" (site_id) VALUES ($1)', [siteId]);
  await db.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES ($1, $2)', [siteId, userId]);
  await db.query('INSERT INTO "MobileLoginHandoff" (user_id) VALUES ($1)', [userId]);
  await db.query('INSERT INTO "SystemAnnouncement" (author_id) VALUES ($1)', [userId]);
}

const countFor = async (table: string, column: string, value: string): Promise<number> =>
  Number((await local.database.query(`SELECT count(*) FROM "${table}" WHERE ${column} = $1`, [value])).rows[0].count);

const insertActiveHold = (siteId: string, startedBy = 'leaving') => local.database.query(`
  INSERT INTO "BatteryHold" (site_id, status, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at, started_by_user_id)
  VALUES ($1, 'active', 20, 100, 90, 500, now() + interval '1 hour', $2)`, [siteId, startedBy]);

describe.skipIf(!safeSocket)('AccountDeletionRepo isolated PostgreSQL', () => {
  afterAll(async () => { await local.database?.end(); });

  // Trigger firing order follows creation order, and the plain Site cascade fails when
  // Tariff fires before EnergyDayArchive. Production has that order; both must work.
  describe.each([
    ['tariff_first', TARIFF_TABLES + ARCHIVE_TABLE],
    ['archive_first', ARCHIVE_TABLE + TARIFF_TABLES],
  ])('with foreign keys created %s', (order, tables) => {
    it('removes a sole-member site and everything the account owns, leaving other accounts alone', async () => {
      await local.database?.end();
      local.database = await createActivityTestDatabase(`account_deletion_${order}`);
      await local.database.query(tables + OTHER_TABLES);
      await applyMigrationsTwice();
      await seedAccount('leaving', 'site-a');
      await seedAccount('staying', 'site-b');
      // Also verify a legacy TRMNL row with installed_by_user_id IS NULL cascades with a deleted site.
      await local.database.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES ($1, NULL)', ['site-a']);

      const result = await new AccountDeletionRepo().deleteAccount('leaving');

      expect(result).toEqual({ deletedSiteIds: ['site-a'], survivingSiteIds: [] });
      expect(await countFor('User', 'id', 'leaving')).toBe(0);
      expect(await countFor('Site', 'id', 'site-a')).toBe(0);
      for (const table of ['SiteMember', 'Tariff', 'EnergyDayArchive', 'EnergyDaySummary', 'LoadTag', 'TrmnlInstallation']) {
        expect(await countFor(table, 'site_id', 'site-a'), table).toBe(0);
        expect(await countFor(table, 'site_id', 'site-b'), table).toBe(1);
      }
      expect(await countFor('MobileLoginHandoff', 'user_id', 'leaving')).toBe(0);
      expect(await countFor('MobileLoginHandoff', 'user_id', 'staying')).toBe(1);
      expect(Number((await local.database.query('SELECT count(*) FROM "SystemAnnouncement" WHERE author_id IS NULL')).rows[0].count)).toBe(1);
    });

    it('keeps a shared site and its history when another member remains, removing only the departing member and their TRMNL device', async () => {
      const db = local.database;
      await seedAccount('member-1', 'site-shared', 'Shared Home');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES (\'member-2\', \'rt-2\', \'active\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-shared\', \'member-2\', \'site-shared-2\')');
      await db.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES (\'site-shared\', \'member-2\')');

      const overview = await new AccountDeletionRepo().getSitesForDeletion('member-1');
      expect(overview).toEqual([
        { id: 'site-shared', name: 'Shared Home', shared: true, hasOtherUsableMember: true, activeHoldOriginalReserve: null },
      ]);

      const result = await new AccountDeletionRepo().deleteAccount('member-1');
      expect(result).toEqual({ deletedSiteIds: [], survivingSiteIds: ['site-shared'] });
      expect(await countFor('User', 'id', 'member-1')).toBe(0);
      expect(await countFor('Site', 'id', 'site-shared')).toBe(1);
      expect(await countFor('EnergyDayArchive', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('EnergyDaySummary', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('SiteMember', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('TrmnlInstallation', 'site_id', 'site-shared')).toBe(1);
      const siteRow = (await db.query('SELECT user_id, tesla_connection_user_id FROM "Site" WHERE id = \'site-shared\'')).rows[0];
      expect(siteRow).toEqual({ user_id: null, tesla_connection_user_id: null });

      // Deleting the last remaining member now removes the site and its history.
      const second = await new AccountDeletionRepo().deleteAccount('member-2');
      expect(second).toEqual({ deletedSiteIds: ['site-shared'], survivingSiteIds: [] });
      expect(await countFor('Site', 'id', 'site-shared')).toBe(0);
      expect(await countFor('EnergyDaySummary', 'site_id', 'site-shared')).toBe(0);
    });

    it('allows deleting a member during an active Battery Saver session when another usable member remains on the site', async () => {
      const db = local.database;
      await seedAccount('member-hold-1', 'site-shared-hold');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES (\'member-hold-2\', \'rt-hold-2\', \'active\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-shared-hold\', \'member-hold-2\', \'tesla-hold-2\')');
      await insertActiveHold('site-shared-hold', 'member-hold-1');

      await expect(new AccountDeletionRepo().deleteAccount('member-hold-1')).resolves.toEqual({
        deletedSiteIds: [],
        survivingSiteIds: ['site-shared-hold'],
      });
      expect(await countFor('BatteryHold', 'site_id', 'site-shared-hold')).toBe(1);
      await db.query('DELETE FROM "BatteryHold" WHERE site_id = \'site-shared-hold\'');
      await new AccountDeletionRepo().deleteAccount('member-hold-2');
    });

    it('refuses while Battery Saver is active with no other usable member and rolls everything back', async () => {
      await seedAccount('holding', 'site-c');
      await insertActiveHold('site-c', 'holding');

      await expect(new AccountDeletionRepo().deleteAccount('holding')).rejects.toBeInstanceOf(ActiveBatterySaverError);

      expect(await countFor('User', 'id', 'holding')).toBe(1);
      expect(await countFor('EnergyDayArchive', 'site_id', 'site-c')).toBe(1);
    });

    it('refuses while a Battery Saver start claim is held on a sole-member site', async () => {
      await local.database.query('DELETE FROM "BatteryHold" WHERE site_id = \'site-c\'');
      await local.database.query(
        `INSERT INTO "BatteryHoldStartClaim" (claim_key, owner, expires_at) VALUES ('hw-site-c', $1::uuid, clock_timestamp() + interval '1 minute')`,
        [randomUUID()],
      );

      await expect(new AccountDeletionRepo().deleteAccount('holding')).rejects.toBeInstanceOf(ActiveBatterySaverError);
      expect(await countFor('User', 'id', 'holding')).toBe(1);
      expect(await countFor('Site', 'id', 'site-c')).toBe(1);
    });

    it('finishes without error when the account is already gone', async () => {
      await expect(new AccountDeletionRepo().deleteAccount('missing')).resolves.toEqual({
        deletedSiteIds: [],
        survivingSiteIds: [],
      });
    });
  });
});
```

Change `cmd/next-app/scripts/test-battery-hold.sh`:

```diff
@@ -17,4 +17,4 @@ LC_ALL=C "$hold_pg_bin/pg_ctl" -D "$hold_socket/data" -l "$hold_socket/server.lo
 hold_started=true
 export BATTERY_HOLD_TEST_SOCKET="$hold_socket"
 npm test -- --run src/lib/battery-hold-postgres.test.ts src/lib/battery-hold-activity-postgres.test.ts \
-  src/lib/battery-hold-activity-delivery-postgres.test.ts src/lib/battery-hold-activity-test-db.test.ts "$@"
+  src/lib/battery-hold-activity-delivery-postgres.test.ts src/lib/battery-hold-activity-test-db.test.ts src/lib/account-deletion-postgres.test.ts "$@"
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test:hold:postgres
```

Expected: FAIL, because `./account-deletion-repo` does not exist.

- [ ] **Step 3: Generate the migration**

```bash
npm run db:migration:create user_account_deletion_cascades
```

Replace the generated file's contents with:

```sql
-- Migration: user_account_deletion_cascades
-- Ensures deleting a sole-member "Site" cascades to its TRMNL installations, and
-- deleting an admin "User" keeps their system announcements.
-- Note: "Site_user_id_fkey" intentionally stays ON DELETE SET NULL (from
-- 20261109135834_add_site_member.sql) so shared sites survive a member's deletion.

-- site_id had no ON DELETE CASCADE before this. Adding one fails loudly if any orphan exists.
ALTER TABLE "TrmnlInstallation"
    DROP CONSTRAINT IF EXISTS "TrmnlInstallation_site_id_fkey",
    ADD CONSTRAINT "TrmnlInstallation_site_id_fkey"
        FOREIGN KEY (site_id) REFERENCES "Site"(id) ON DELETE CASCADE;

ALTER TABLE "SystemAnnouncement"
    DROP CONSTRAINT IF EXISTS "SystemAnnouncement_author_id_fkey",
    ADD CONSTRAINT "SystemAnnouncement_author_id_fkey"
        FOREIGN KEY (author_id) REFERENCES "User"(id) ON DELETE SET NULL;
```

- [ ] **Step 4: Add the repo**

Create `cmd/next-app/src/lib/account-deletion-repo.ts`:

```typescript
import { pool } from './db';

/**
 * A Battery Saver session (or in-flight start claim) is active on a site that has no
 * other usable member, so deleting now would strand the Powerwall at a raised reserve.
 */
export class ActiveBatterySaverError extends Error {
    constructor() {
        super('Battery Saver is active on a site with no other usable member');
        this.name = 'ActiveBatterySaverError';
    }
}

export interface SiteDeletionOverview {
    id: string;
    name: string;
    shared: boolean;
    hasOtherUsableMember: boolean;
    activeHoldOriginalReserve: number | null;
}

export interface AccountDeletionCommitResult {
    deletedSiteIds: string[];
    survivingSiteIds: string[];
}

const OTHER_USABLE_MEMBER_EXISTS = `
    EXISTS (
        SELECT 1 FROM "SiteMember" m
        JOIN "User" u ON u.id = m.user_id
        WHERE m.site_id = s.id AND m.user_id <> $1
          AND u.is_active = true AND NULLIF(u.refresh_token, '') IS NOT NULL
          AND u.auth_status IS DISTINCT FROM 'revoked'
          AND u.tesla_refresh_state IS DISTINCT FROM 'uncertain'
          AND u.tesla_refresh_state IS DISTINCT FROM 'reconnect_required'
    )`;

export class AccountDeletionRepo {
    /**
     * Lists the sites the user belongs to, whether another member shares each site,
     * whether another usable member could restore Battery Saver, and the active
     * Battery Saver original reserve if any.
     */
    async getSitesForDeletion(userId: string): Promise<SiteDeletionOverview[]> {
        const { rows } = await pool.query<{
            id: string;
            name: string;
            shared: boolean;
            has_other_usable_member: boolean;
            original_reserve: number | null;
        }>(`
            SELECT s.id, s.name,
                EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id <> $1) AS shared,
                ${OTHER_USABLE_MEMBER_EXISTS} AS has_other_usable_member,
                h.original_reserve
            FROM "Site" s
            LEFT JOIN LATERAL (
                SELECT original_reserve FROM "BatteryHold"
                WHERE site_id = s.id AND status = 'active'
                ORDER BY created_at DESC LIMIT 1
            ) h ON true
            WHERE s.id IN (
                SELECT site_id FROM "SiteMember" WHERE user_id = $1
                UNION
                SELECT id FROM "Site" WHERE user_id = $1
            )
            ORDER BY s.id
        `, [userId]);

        return rows.map(row => ({
            id: row.id,
            name: row.name,
            shared: row.shared,
            hasOtherUsableMember: row.has_other_usable_member,
            activeHoldOriginalReserve: row.original_reserve === null ? null : Number(row.original_reserve),
        }));
    }

    /**
     * Removes the account, its memberships, its TRMNL installations, and any site
     * where this user was the last member.
     *
     * Locking User and Site rows in deterministic id order serializes concurrent
     * member deletions and blocks new holds or memberships until commit.
     */
    async deleteAccount(userId: string): Promise<AccountDeletionCommitResult> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [userId]);
            if (userRes.rowCount === 0) {
                await client.query('COMMIT');
                return { deletedSiteIds: [], survivingSiteIds: [] };
            }

            const sites = await client.query<{
                id: string;
                claim_key: string;
                has_other_member: boolean;
                has_other_usable_member: boolean;
            }>(`
                SELECT s.id,
                    COALESCE(s.tesla_hardware_id, 'site:' || s.id) AS claim_key,
                    EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id AND m.user_id <> $1) AS has_other_member,
                    ${OTHER_USABLE_MEMBER_EXISTS} AS has_other_usable_member
                FROM "Site" s
                WHERE s.id IN (
                    SELECT site_id FROM "SiteMember" WHERE user_id = $1
                    UNION
                    SELECT id FROM "Site" WHERE user_id = $1
                )
                ORDER BY s.id
                FOR UPDATE
            `, [userId]);

            const allSiteIds = sites.rows.map(row => row.id);
            const sitesNeedingRestore = sites.rows.filter(row => !row.has_other_usable_member).map(row => row.id);
            const soleSiteClaimKeys = sites.rows.filter(row => !row.has_other_member).map(row => row.claim_key);

            if (sitesNeedingRestore.length > 0) {
                const activeHolds = await client.query(
                    `SELECT 1 FROM "BatteryHold" WHERE site_id = ANY($1::text[]) AND status = 'active' LIMIT 1`,
                    [sitesNeedingRestore],
                );
                if (activeHolds.rows.length > 0) throw new ActiveBatterySaverError();
            }

            if (soleSiteClaimKeys.length > 0) {
                const activeClaims = await client.query(
                    `SELECT 1 FROM "BatteryHoldStartClaim" WHERE claim_key = ANY($1::text[]) AND expires_at > clock_timestamp() LIMIT 1`,
                    [soleSiteClaimKeys],
                );
                if (activeClaims.rows.length > 0) throw new ActiveBatterySaverError();
            }

            await client.query('DELETE FROM "MobileLoginHandoff" WHERE user_id = $1', [userId]);
            if (allSiteIds.length > 0) {
                await client.query(
                    'DELETE FROM "TrmnlInstallation" WHERE installed_by_user_id = $1 AND site_id = ANY($2::text[])',
                    [userId, allSiteIds],
                );
            }
            await client.query('DELETE FROM "SiteMember" WHERE user_id = $1', [userId]);

            const goneRes = await client.query<{ id: string }>(`
                SELECT s.id FROM "Site" s
                WHERE s.id = ANY($1::text[])
                  AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)
                ORDER BY s.id
            `, [allSiteIds]);
            const deletedSiteIds = goneRes.rows.map(row => row.id);
            const deletedSet = new Set(deletedSiteIds);
            const survivingSiteIds = allSiteIds.filter(id => !deletedSet.has(id));

            if (deletedSiteIds.length > 0) {
                // EnergyDaySummary has NO ACTION keys to Tariff and TariffSchedule. Removing
                // archives first removes the summaries, so the Site cascade cannot fail on
                // them whichever order its triggers fire in.
                await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id = ANY($1::text[])', [deletedSiteIds]);
                await client.query('DELETE FROM "Site" WHERE id = ANY($1::text[])', [deletedSiteIds]);
            }

            await client.query('DELETE FROM "User" WHERE id = $1', [userId]);
            await client.query('COMMIT');
            return { deletedSiteIds, survivingSiteIds };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
```

- [ ] **Step 5: Run the suite and confirm it passes**

```bash
npm run test:hold:postgres
```

Expected: PASS, including both foreign key orders, shared-site survival, and sole-member deletion.

- [ ] **Step 6: Commit**

```bash
git add db-migrations src/lib/account-deletion-repo.ts src/lib/account-deletion-postgres.test.ts scripts/test-battery-hold.sh
git commit -m "feat(db): add membership-aware account deletion and cascades"
```

---

### Task 2: Shared helpers

Extracted so the deletion code reuses the existing logic instead of copying it.

**Files:**
- Modify: `cmd/next-app/src/lib/observability.ts`
- Modify: `cmd/next-app/src/lib/request-security.ts`
- Modify: `cmd/next-app/src/app/api/auth/sign-out-everywhere/route.ts`

- [ ] **Step 1: Add `accountFingerprint`**

Change `cmd/next-app/src/lib/observability.ts`:

```diff
@@ -154,10 +154,15 @@ export function setLogContext(fields: { siteId: string } | { siteIds: string[] }
 type SessionRejection = 'missing-cookie' | 'invalid-session' | 'expired-session'
     | 'missing-account' | 'inactive-account' | 'revoked-session' | 'site-not-assigned';
 
+/** A stable, non-reversible account id for logs. Raw user ids can be email addresses. */
+export function accountFingerprint(userId: string): string {
+    return createHash('sha256').update(userId).digest('hex').slice(0, 16);
+}
+
 /** Fixed reasons and the same account fingerprint used by Tesla refresh events. */
 export function logSessionRejection(reason: SessionRejection, userId?: string): void {
     logEvent('info', 'auth.session.rejected', {
-        reason, ...(userId ? { accountId: createHash('sha256').update(userId).digest('hex').slice(0, 16) } : {}),
+        reason, ...(userId ? { accountId: accountFingerprint(userId) } : {}),
     });
 }
 
```

- [ ] **Step 2: Add `isCrossOriginRequest` and use it in sign-out-everywhere**

Change `cmd/next-app/src/lib/request-security.ts`:

```diff
@@ -14,3 +14,19 @@ export function isSecureRequest(request: NextRequest): boolean {
     const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim().toLowerCase();
     return forwardedProto === 'https' || request.nextUrl.protocol === 'https:';
 }
+
+/**
+ * CSRF defense in depth for cookie-authenticated writes. An absent Origin is allowed
+ * because URLSession requests from the iOS app may omit it.
+ */
+export function isCrossOriginRequest(request: NextRequest): boolean {
+    const origin = request.headers.get('origin');
+    if (origin) {
+        try {
+            if (new URL(origin).origin !== request.nextUrl.origin) return true;
+        } catch {
+            return true;
+        }
+    }
+    return request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site';
+}
```

Change `cmd/next-app/src/app/api/auth/sign-out-everywhere/route.ts`:

```diff
@@ -1,7 +1,7 @@
 import { NextRequest, NextResponse } from 'next/server';
 import { getCurrentUser } from '@/lib/auth-checks';
 import { UserRepo } from '@/lib/user-repo';
-import { isSecureRequest } from '@/lib/request-security';
+import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';
 
 export const dynamic = 'force-dynamic';
 
@@ -22,22 +22,7 @@ function jsonError(error: string, status: number): NextResponse {
  * in depth consistent with the mobile session exchange route.
  */
 export async function POST(request: NextRequest): Promise<NextResponse> {
-    const origin = request.headers.get('origin');
-    if (origin) {
-        let originUrl: URL;
-        try {
-            originUrl = new URL(origin);
-        } catch {
-            return jsonError('Cross-origin requests are not allowed', 403);
-        }
-        if (originUrl.origin !== request.nextUrl.origin) {
-            return jsonError('Cross-origin requests are not allowed', 403);
-        }
-    }
-
-    if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
-        return jsonError('Cross-origin requests are not allowed', 403);
-    }
+    if (isCrossOriginRequest(request)) return jsonError('Cross-origin requests are not allowed', 403);
 
     const user = await getCurrentUser();
     if (!user) return jsonError('Unauthorized', 401);
```

- [ ] **Step 3: Confirm behaviour did not change**

```bash
npm test -- --run src/app/api/auth/sign-out-everywhere
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/observability.ts src/lib/request-security.ts src/app/api/auth/sign-out-everywhere/route.ts
git commit -m "refactor(auth): extract account fingerprint and cross-origin check"
```

---

### Task 3: Account deletion service

**Files:**
- Create: `cmd/next-app/src/lib/account-deletion-service.test.ts`
- Create: `cmd/next-app/src/lib/account-deletion-service.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/account-deletion-service.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invalidateCache: vi.fn(),
    repairConnection: vi.fn(),
    createClient: vi.fn(),
    restoreBattery: vi.fn(),
    getSitesForDeletion: vi.fn(),
    repoDelete: vi.fn(),
    logEvent: vi.fn(),
}));

vi.mock('./site-repo', () => ({
    SiteRepo: class {
        invalidateCache = mocks.invalidateCache;
        repairConnection = mocks.repairConnection;
    },
}));
vi.mock('./battery-hold-repo', () => ({
    BatteryHoldRepo: class {},
}));
vi.mock('./battery-hold-service', () => ({
    createSiteTeslaClient: mocks.createClient,
    restoreBattery: mocks.restoreBattery,
}));
vi.mock('./account-deletion-repo', () => {
    class ActiveBatterySaverError extends Error {}
    return {
        ActiveBatterySaverError,
        AccountDeletionRepo: class {
            getSitesForDeletion = mocks.getSitesForDeletion;
            deleteAccount = mocks.repoDelete;
        },
    };
});
vi.mock('./observability', () => ({
    accountFingerprint: (userId: string) => `hash-of-${userId}`,
    logEvent: mocks.logEvent,
}));

import { ActiveBatterySaverError } from './account-deletion-repo';
import { deleteAccount, getAccountDeletionSites } from './account-deletion-service';

describe('account deletion service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: null },
        ]);
        mocks.createClient.mockResolvedValue({ tesla: true });
        mocks.repoDelete.mockResolvedValue({ deletedSiteIds: ['site-1'], survivingSiteIds: [] });
        mocks.repairConnection.mockResolvedValue(null);
    });

    it('lists sites with shared status and the reserve Battery Saver would restore', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
            { id: 'site-2', name: 'Cabin', shared: true, hasOtherUsableMember: true, activeHoldOriginalReserve: 30 },
        ]);
        await expect(getAccountDeletionSites('user-1')).resolves.toEqual([
            { id: 'site-1', name: 'Home', shared: false, batterySaverRestoreReserve: 20 },
            { id: 'site-2', name: 'Cabin', shared: true, batterySaverRestoreReserve: null },
        ]);
    });

    it('deletes without touching Tesla when Battery Saver is off', async () => {
        await expect(deleteAccount('user-1')).resolves.toEqual({
            status: 'deleted',
            sitesDeleted: 1,
            sitesRetained: 0,
        });
        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(mocks.invalidateCache).toHaveBeenCalledWith('site-1');
    });

    it('skips Battery Saver restore and repairs connection when another usable member remains on a shared site', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-shared', name: 'Home', shared: true, hasOtherUsableMember: true, activeHoldOriginalReserve: 20 },
        ]);
        mocks.repoDelete.mockResolvedValue({ deletedSiteIds: [], survivingSiteIds: ['site-shared'] });

        await expect(deleteAccount('user-1')).resolves.toEqual({
            status: 'deleted',
            sitesDeleted: 0,
            sitesRetained: 1,
        });
        expect(mocks.restoreBattery).not.toHaveBeenCalled();
        expect(mocks.repairConnection).toHaveBeenCalledWith('site-shared');
        expect(mocks.invalidateCache).toHaveBeenCalledWith('site-shared');
    });

    it('logs a fingerprint and site counts, never the raw user id', async () => {
        await deleteAccount('user-1');
        expect(mocks.logEvent).toHaveBeenCalledWith('info', 'user.account-deletion.completed', {
            accountId: 'hash-of-user-1',
            sitesDeleted: 1,
            sitesRetained: 0,
        });
        expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('"user-1"');
    });

    it.each([['ok'], ['reserve_changed'], ['no_active_hold']])('deletes after a %s restore', async status => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status });
        await expect(deleteAccount('user-1')).resolves.toMatchObject({ status: 'deleted' });
        expect(mocks.restoreBattery).toHaveBeenCalledWith(expect.objectContaining({
            siteId: 'site-1',
            actorUserId: 'user-1',
            reason: 'manual',
        }));
    });

    it('keeps the account when Tesla needs reconnecting', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status: 'needs_reauth' });
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'needs_reconnect' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('keeps the account when no Tesla client can be built', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.createClient.mockResolvedValue(null);
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'needs_reconnect' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('keeps the account when the restore cannot be confirmed', async () => {
        mocks.getSitesForDeletion.mockResolvedValue([
            { id: 'site-1', name: 'Home', shared: false, hasOtherUsableMember: false, activeHoldOriginalReserve: 20 },
        ]);
        mocks.restoreBattery.mockResolvedValue({ status: 'error', message: 'uncertain' });
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'battery_saver_pending' });
        expect(mocks.repoDelete).not.toHaveBeenCalled();
    });

    it('reports a session that started during deletion', async () => {
        mocks.repoDelete.mockRejectedValue(new ActiveBatterySaverError());
        await expect(deleteAccount('user-1')).resolves.toEqual({ status: 'battery_saver_pending' });
    });

    it('rethrows database failures', async () => {
        mocks.repoDelete.mockRejectedValue(new Error('connection lost'));
        await expect(deleteAccount('user-1')).rejects.toThrow('connection lost');
        expect(mocks.logEvent).toHaveBeenCalledWith('error', 'user.account-deletion.failed', expect.anything());
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm test -- --run src/lib/account-deletion-service.test.ts
```

Expected: FAIL, because the service does not exist.

- [ ] **Step 3: Add the service**

Create `cmd/next-app/src/lib/account-deletion-service.ts`:

```typescript
import { AccountDeletionRepo, ActiveBatterySaverError } from './account-deletion-repo';
import { BatteryHoldRepo } from './battery-hold-repo';
import { createSiteTeslaClient, restoreBattery, type RestoreResult } from './battery-hold-service';
import { accountFingerprint, logEvent } from './observability';
import { SiteRepo } from './site-repo';

export interface AccountDeletionSite {
    id: string;
    name: string;
    /** True when another member also belongs to this site, so the site and its history will stay. */
    shared: boolean;
    /** The reserve Battery Saver will restore on deletion; null when no restore is needed. */
    batterySaverRestoreReserve: number | null;
}

export type AccountDeletionResult =
    | { status: 'deleted'; sitesDeleted: number; sitesRetained: number }
    | { status: 'needs_reconnect' }
    | { status: 'battery_saver_pending' };

export async function getAccountDeletionSites(userId: string): Promise<AccountDeletionSite[]> {
    const overview = await new AccountDeletionRepo().getSitesForDeletion(userId);
    return overview.map(site => ({
        id: site.id,
        name: site.name,
        shared: site.shared,
        batterySaverRestoreReserve: site.hasOtherUsableMember ? null : site.activeHoldOriginalReserve,
    }));
}

async function restoreSiteBatterySaver(siteId: string, userId: string, repo: BatteryHoldRepo): Promise<RestoreResult> {
    const client = await createSiteTeslaClient(siteId);
    if (!client) return { status: 'needs_reauth' };
    return restoreBattery({ client, repo, siteId, actorUserId: userId, reason: 'manual' });
}

/**
 * Restores any active Battery Saver session on sites where no other usable member
 * remains, deletes the account in one transaction, and repairs the Tesla connection
 * for any surviving shared sites.
 */
export async function deleteAccount(userId: string): Promise<AccountDeletionResult> {
    const accountId = accountFingerprint(userId);
    const deletionRepo = new AccountDeletionRepo();
    const siteRepo = new SiteRepo();
    const holdRepo = new BatteryHoldRepo();

    for (const site of await deletionRepo.getSitesForDeletion(userId)) {
        if (site.activeHoldOriginalReserve === null || site.hasOtherUsableMember) continue;
        const restore = await restoreSiteBatterySaver(site.id, userId, holdRepo);
        if (restore.status === 'needs_reauth') {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'needs_reconnect' });
            return { status: 'needs_reconnect' };
        }
        if (restore.status === 'error') {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'restore_unconfirmed' });
            return { status: 'battery_saver_pending' };
        }
    }

    let deletedSiteIds: string[];
    let survivingSiteIds: string[];
    try {
        ({ deletedSiteIds, survivingSiteIds } = await deletionRepo.deleteAccount(userId));
    } catch (error) {
        if (error instanceof ActiveBatterySaverError) {
            logEvent('warn', 'user.account-deletion.blocked', { accountId, reason: 'battery_saver_started' });
            return { status: 'battery_saver_pending' };
        }
        logEvent('error', 'user.account-deletion.failed', { accountId, error });
        throw error;
    }

    for (const siteId of survivingSiteIds) {
        await siteRepo.repairConnection(siteId);
        siteRepo.invalidateCache(siteId);
    }
    for (const siteId of deletedSiteIds) {
        siteRepo.invalidateCache(siteId);
    }

    logEvent('info', 'user.account-deletion.completed', {
        accountId,
        sitesDeleted: deletedSiteIds.length,
        sitesRetained: survivingSiteIds.length,
    });
    return {
        status: 'deleted',
        sitesDeleted: deletedSiteIds.length,
        sitesRetained: survivingSiteIds.length,
    };
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npm test -- --run src/lib/account-deletion-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/account-deletion-service.ts src/lib/account-deletion-service.test.ts
git commit -m "feat(account): restore Battery Saver and repair shared sites on account deletion"
```

---

### Task 4: `DELETE /api/user` and `/auth/tesla-callback` for zero-site deletion

**Files:**
- Create: `cmd/next-app/src/app/api/user/route.test.ts`
- Create: `cmd/next-app/src/app/api/user/route.ts`
- Modify: `cmd/next-app/src/app/auth/tesla-callback/route.ts`
- Modify: `cmd/next-app/src/app/auth/tesla-callback/route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cmd/next-app/src/app/api/user/route.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), deleteAccount: vi.fn() }));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/account-deletion-service', () => ({ deleteAccount: mocks.deleteAccount }));

import { DELETE } from './route';

function makeRequest(body: unknown = { confirm: 'DELETE' }, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest('https://pwusage.test/api/user', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('DELETE /api/user', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
        mocks.deleteAccount.mockResolvedValue({ status: 'deleted', sitesDeleted: 1, sitesRetained: 0 });
    });

    it('deletes the account and clears the session cookie', async () => {
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(mocks.deleteAccount).toHaveBeenCalledWith('user-1');
        const cookie = response.cookies.get('site_auth');
        expect(cookie?.value).toBe('');
        expect(cookie?.maxAge).toBe(0);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
        [{ origin: 'https://evil.test' }],
        [{ origin: 'not a url' }],
        [{ 'sec-fetch-site': 'cross-site' }],
    ])('rejects cross-origin requests: %j', async headers => {
        const response = await DELETE(makeRequest({ confirm: 'DELETE' }, headers));
        expect(response.status).toBe(403);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it('accepts a same-origin request', async () => {
        const response = await DELETE(makeRequest({ confirm: 'DELETE' }, {
            origin: 'https://pwusage.test',
            'sec-fetch-site': 'same-origin',
        }));
        expect(response.status).toBe(200);
    });

    it('rejects unauthenticated requests', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(401);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it.each([[{ confirm: 'delete' }], [{}], [null], ['not json']])('rejects bad confirmation: %j', async body => {
        const response = await DELETE(makeRequest(body));
        expect(response.status).toBe(400);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it.each([
        ['needs_reconnect', 'TESLA_CONNECTION_REQUIRED'],
        ['battery_saver_pending', 'BATTERY_SAVER_PENDING'],
    ])('keeps the session when the result is %s', async (status, code) => {
        mocks.deleteAccount.mockResolvedValue({ status });
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe(code);
        expect(response.cookies.get('site_auth')).toBeUndefined();
    });

    it('keeps the session and returns 500 when deletion throws', async () => {
        mocks.deleteAccount.mockRejectedValue(new Error('connection lost'));
        const response = await DELETE(makeRequest());
        expect(response.status).toBe(500);
        expect(response.cookies.get('site_auth')).toBeUndefined();
        expect(JSON.stringify(await response.json())).not.toContain('connection lost');
    });
});
```

Change `cmd/next-app/src/app/auth/tesla-callback/route.test.ts` to add a test for zero-site users signing in with `callback=/account-delete`:

```diff
@@ -240,6 +240,22 @@ describe('GET /auth/tesla-callback', () => {
         expect(mocks.cookieDelete).toHaveBeenCalledWith('site_auth');
         expect(mocks.cookieDelete).toHaveBeenCalledWith('auth_state');
         expect(mocks.redirect).toHaveBeenCalledWith('/no-sites');
     });
 
+    it('sets site_auth and redirects to /account-delete when a zero-site user signs in to delete their account', async () => {
+        mocks.handleTeslaCallback.mockResolvedValue({
+            status: 'success',
+            siteIds: [],
+            roles: [],
+            userId: 'user-123',
+        });
+        mocks.getCookie.mockImplementation((name: string) => name === 'auth_callback' ? { value: '/account-delete' } : undefined);
+
+        const req = new NextRequest('http://localhost:5173/auth/tesla-callback?code=abc&state=xyz');
+        await expect(GET(req)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;') });
+
+        expect(mocks.cookieSet).toHaveBeenCalledWith('site_auth', 'signed-site-token', expect.any(Object));
+        expect(mocks.redirect).toHaveBeenCalledWith('/account-delete');
+    });
+
     it('redirects to saved callback only when it is safe relative path', async () => {
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm test -- --run src/app/api/user src/app/auth/tesla-callback/route.test.ts
```

- [ ] **Step 3: Add `DELETE /api/user` and update `/auth/tesla-callback`**

Create `cmd/next-app/src/app/api/user/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { deleteAccount } from '@/lib/account-deletion-service';
import { getCurrentUser } from '@/lib/auth-checks';
import { observeRoute } from '@/lib/observability';
import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function jsonError(error: string, status: number, code?: string): NextResponse {
    return NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: NO_STORE });
}

/**
 * DELETE /api/user permanently deletes the signed-in account. CSRF: site_auth is
 * SameSite=Lax, and the origin check is defense in depth, matching sign-out-everywhere.
 */
async function handleDELETE(request: NextRequest): Promise<NextResponse> {
    if (isCrossOriginRequest(request)) return jsonError('Cross-origin requests are not allowed', 403);

    const user = await getCurrentUser();
    if (!user) return jsonError('Sign in again, then try again.', 401);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonError('Invalid request body', 400);
    }
    if ((body as { confirm?: unknown } | null)?.confirm !== 'DELETE') {
        return jsonError('Type DELETE to confirm.', 400);
    }

    let result;
    try {
        result = await deleteAccount(user.id);
    } catch {
        return jsonError('Could not delete your account. Your account was not changed. Try again.', 500);
    }

    if (result.status === 'needs_reconnect') {
        return jsonError(
            'Reconnect Tesla so pwusage can restore your Powerwall backup reserve, then try again. Your account was not deleted.',
            409,
            'TESLA_CONNECTION_REQUIRED',
        );
    }
    if (result.status === 'battery_saver_pending') {
        return jsonError(
            'Could not confirm your Powerwall backup reserve was restored. Your account was not deleted. Try again in a few minutes.',
            409,
            'BATTERY_SAVER_PENDING',
        );
    }

    const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
    response.cookies.set('site_auth', '', {
        httpOnly: true,
        secure: isSecureRequest(request),
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
    });
    return response;
}

export const DELETE = observeRoute('/api/user', handleDELETE);
```

Change `cmd/next-app/src/app/auth/tesla-callback/route.ts`:

```diff
@@ -181,13 +181,14 @@ async function handleGET(request: NextRequest) {
             return mobileCallbackResponse({ code: handoff.code, attempt: handoff.attemptId, state: mobileState });
         }
 
-        if (result.siteIds.length === 0 && !result.roles.includes('admin')) {
+        const allowZeroSitesForDeletion = savedCallback === '/account-delete';
+        if (result.siteIds.length === 0 && !result.roles.includes('admin') && !allowZeroSitesForDeletion) {
             cookieStore.delete('site_auth');
             clearAttempt();
             redirect('/no-sites');
         }
 
-        if (result.siteIds.length > 0 || result.roles.includes('admin')) {
+        if (result.siteIds.length > 0 || result.roles.includes('admin') || allowZeroSitesForDeletion) {
             const { signSiteToken, COOKIE_MAX_AGE_SECONDS } = await import('@/lib/auth-jwt');
             // Stamp the user's current session_version so a fresh login after a
             // sign-out-everywhere bump is not immediately treated as revoked.
```

- [ ] **Step 4: Run them and confirm they pass**

```bash
npm test -- --run src/app/api/user src/app/auth/tesla-callback/route.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/user src/app/auth/tesla-callback/route.ts src/app/auth/tesla-callback/route.test.ts
git commit -m "feat(api): add DELETE /api/user and allow zero-site login for deletion"
```

---

### Task 5: `/account-delete` pages

**Files:**
- Modify: `cmd/next-app/src/components/ui/Button.tsx`
- Create: `cmd/next-app/src/lib/account-deletion-request.ts` and its test
- Create: `cmd/next-app/src/components/account/AccountDeleteForm.tsx`
- Create: `cmd/next-app/src/app/account-delete/page.tsx` and its test
- Create: `cmd/next-app/src/app/account-delete/cancel/route.ts` and its test
- Create: `cmd/next-app/src/app/account-delete/done/page.tsx` and its test

- [ ] **Step 1: Add the `danger` button variant**

Change `cmd/next-app/src/components/ui/Button.tsx`:

```diff
@@ -1,7 +1,7 @@
 import React from 'react';
 
 interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
-    variant?: 'primary' | 'secondary' | 'outline';
+    variant?: 'primary' | 'secondary' | 'outline' | 'danger';
     size?: 'sm' | 'md' | 'lg';
     appearance?: 'default' | 'glyph' | 'icon';
     icon?: React.ReactNode;
@@ -28,6 +28,7 @@ export function Button({
     const variants = {
         primary: "bg-primary text-bg-base hover:bg-primary/90 shadow-sm disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 disabled:shadow-none",
         secondary: "bg-secondary text-gray-900 dark:text-gray-100 hover:bg-secondary/80 disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500",
+        danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 disabled:shadow-none",
         outline: "border border-secondary bg-transparent hover:bg-bg-muted text-gray-900 dark:text-gray-100 dark:hover:text-gray-900 disabled:border-gray-200 disabled:text-gray-400 dark:disabled:border-slate-800 dark:disabled:text-slate-500"
     };
 
```

- [ ] **Step 2: Write the failing tests**

Create `cmd/next-app/src/lib/account-deletion-request.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { requestAccountDeletion } from './account-deletion-request';

const respond = (status: number, body: string) => vi.fn().mockResolvedValue(new Response(body, { status }));

describe('requestAccountDeletion', () => {
    it('sends the typed confirmation', async () => {
        const fetcher = respond(200, '{"ok":true}');
        await expect(requestAccountDeletion(fetcher)).resolves.toEqual({ ok: true });
        expect(fetcher).toHaveBeenCalledWith('/api/user', expect.objectContaining({
            method: 'DELETE',
            body: JSON.stringify({ confirm: 'DELETE' }),
        }));
    });

    it('shows the message from the server', async () => {
        const fetcher = respond(409, '{"error":"Reconnect Tesla."}');
        await expect(requestAccountDeletion(fetcher)).resolves.toEqual({ ok: false, message: 'Reconnect Tesla.' });
    });

    it('falls back when the error body is not JSON', async () => {
        const result = await requestAccountDeletion(respond(502, 'Bad gateway'));
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Check your connection') });
    });

    it('falls back when the network fails', async () => {
        const result = await requestAccountDeletion(vi.fn().mockRejectedValue(new Error('offline')));
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Check your connection') });
    });
});
```

Create `cmd/next-app/src/app/account-delete/page.test.tsx`:

```typescript
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getSites: vi.fn(),
    redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }),
}));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/account-deletion-service', () => ({ getAccountDeletionSites: mocks.getSites }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import AccountDeletePage, { metadata } from './page';

const render = async () => renderToStaticMarkup(await AccountDeletePage());

describe('/account-delete', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, batterySaverRestoreReserve: null },
        ]);
    });

    it('sends signed-out visitors through login and back', async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        await expect(render()).rejects.toThrow('redirect:/login?callback=/account-delete');
    });

    it('stays out of search results', () => {
        expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('lists sole-member sites that will be deleted and starts with the button disabled', async () => {
        const html = await render();
        expect(html).toContain('Lake House');
        expect(html).not.toContain('Battery Saver is on');
        expect(html).toMatch(/<button[^>]*disabled[^>]*>Permanently Delete Account/);
        expect(html).toContain('href="/account-delete/cancel"');
    });

    it('distinguishes shared sites that stay available to other members', async () => {
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, batterySaverRestoreReserve: null },
            { id: 's2', name: 'Main Home', shared: true, batterySaverRestoreReserve: null },
        ]);
        const html = await render();
        expect(html).toContain('Lake House');
        expect(html).toContain('Main Home');
        expect(html).toContain('stay available to the other members');
    });

    it('warns about an active Battery Saver session with the reserve it restores', async () => {
        mocks.getSites.mockResolvedValue([
            { id: 's1', name: 'Lake House', shared: false, batterySaverRestoreReserve: 20 },
        ]);
        const html = await render();
        expect(html).toContain('Battery Saver is on for Lake House');
        expect(html).toContain('restores your backup reserve to 20%');
    });

    it('explains an account with no sites', async () => {
        mocks.getSites.mockResolvedValue([]);
        expect(await render()).toContain('No sites are linked to this account');
    });
});
```

Create `cmd/next-app/src/app/account-delete/cancel/route.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: mocks.getCurrentUser }));

import { GET } from './route';

describe('GET /account-delete/cancel', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it.each([[{ id: 'user-1' }], [null]])('returns to the profile page for %j', async user => {
        mocks.getCurrentUser.mockResolvedValue(user);
        const response = await GET(new NextRequest('https://pwusage.test/account-delete/cancel'));
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('https://pwusage.test/profile');
    });
});
```

Create `cmd/next-app/src/app/account-delete/done/page.test.tsx`:

```typescript
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountDeleteDonePage, { metadata } from './page';

describe('/account-delete/done', () => {
    beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://pwusage.test'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('links to the Tesla consent page and returns here', () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', 'client-123');
        const html = renderToStaticMarkup(<AccountDeleteDonePage />);
        expect(html).toContain('https://auth.tesla.com/user/revoke/consent?revoke_client_id=client-123');
        expect(html).toContain(encodeURIComponent('https://pwusage.test/account-delete/done'));
    });

    it('falls back to instructions without a client id', () => {
        vi.stubEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID', '');
        const html = renderToStaticMarkup(<AccountDeleteDonePage />);
        expect(html).not.toContain('auth.tesla.com');
        expect(html).toContain('third-party app settings');
    });

    it('stays out of search results', () => {
        expect(metadata.robots).toEqual({ index: false, follow: false });
    });
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm test -- --run src/lib/account-deletion-request.test.ts src/app/account-delete
```

- [ ] **Step 4: Add the implementation**

Create `cmd/next-app/src/lib/account-deletion-request.ts`:

```typescript
export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE';

export type AccountDeletionRequestResult = { ok: true } | { ok: false; message: string };

const FALLBACK_MESSAGE = 'Could not delete your account. Check your connection and try again.';

export async function requestAccountDeletion(fetcher: typeof fetch = fetch): Promise<AccountDeletionRequestResult> {
    try {
        const response = await fetcher('/api/user', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: ACCOUNT_DELETE_CONFIRMATION }),
        });
        if (response.ok) return { ok: true };
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        return { ok: false, message: typeof body?.error === 'string' ? body.error : FALLBACK_MESSAGE };
    } catch {
        return { ok: false, message: FALLBACK_MESSAGE };
    }
}
```

Create `cmd/next-app/src/components/account/AccountDeleteForm.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Form';
import { ACCOUNT_DELETE_CONFIRMATION, requestAccountDeletion } from '@/lib/account-deletion-request';

export function AccountDeleteForm() {
    const [confirmation, setConfirmation] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (confirmation !== ACCOUNT_DELETE_CONFIRMATION || isDeleting) return;
        setIsDeleting(true);
        setError(null);
        const result = await requestAccountDeletion();
        if (result.ok) {
            window.location.replace('/account-delete/done');
            return;
        }
        setError(result.message);
        setIsDeleting(false);
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
                <Alert variant="danger">
                    <AlertTitle>Account not deleted</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            <div className="space-y-2">
                <Label htmlFor="account-delete-confirmation">
                    Type {ACCOUNT_DELETE_CONFIRMATION} to confirm
                </Label>
                <Input
                    id="account-delete-confirmation"
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                    disabled={isDeleting}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="font-mono"
                />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                {/* A plain link: the cancel route records telemetry, so it must not be prefetched. */}
                <a href="/account-delete/cancel" className="sm:order-first">
                    <Button renderAs="span" variant="outline" className="w-full">Cancel</Button>
                </a>
                <Button
                    type="submit"
                    variant="danger"
                    disabled={confirmation !== ACCOUNT_DELETE_CONFIRMATION || isDeleting}
                >
                    {isDeleting ? 'Deleting Account' : 'Permanently Delete Account'}
                </Button>
            </div>
        </form>
    );
}
```

Create `cmd/next-app/src/app/account-delete/page.tsx`:

```typescript
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AccountDeleteForm } from '@/components/account/AccountDeleteForm';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { getAccountDeletionSites } from '@/lib/account-deletion-service';
import { getCurrentUser } from '@/lib/auth-checks';
import { accountFingerprint, logEvent, observePage } from '@/lib/observability';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Delete Account | Powerwall Usage',
    robots: { index: false, follow: false },
};

export default observePage('/account-delete', async function AccountDeletePage() {
    const user = await getCurrentUser();
    if (!user) redirect('/login?callback=/account-delete');

    const sites = await getAccountDeletionSites(user.id);
    const soleSites = sites.filter(site => !site.shared);
    const sharedSites = sites.filter(site => site.shared);
    const batterySaverSites = sites.filter(site => site.batterySaverRestoreReserve !== null);
    logEvent('info', 'user.account-deletion.page-viewed', {
        accountId: accountFingerprint(user.id),
        siteCount: sites.length,
        sitesDeleted: soleSites.length,
        sitesRetained: sharedSites.length,
        batterySaverActive: batterySaverSites.length > 0,
    });

    return (
        <PageShell maxWidth="lg">
            <PageHeader
                title="Delete Account"
                description="Permanently delete your pwusage account. This cannot be undone."
                className="mb-6"
            />
            <div className="space-y-6">
                {batterySaverSites.map(site => (
                    <Alert key={site.id} variant="warning">
                        <AlertTitle>Battery Saver is on for {site.name}</AlertTitle>
                        <AlertDescription>
                            Battery Saver is holding your Powerwall charge. Deleting your account turns it off and
                            restores your backup reserve to {site.batterySaverRestoreReserve}%.
                        </AlertDescription>
                    </Alert>
                ))}
                <SectionCard title="What gets deleted" bodyClassName="space-y-4 text-sm">
                    {sites.length === 0 && (
                        <p>Your pwusage account and the Tesla sign-in details stored with it. No sites are linked to this account.</p>
                    )}
                    {soleSites.length > 0 && (
                        <>
                            <p>Your pwusage account and these sites, with their history, rate plans, Battery Saver settings and TRMNL connections:</p>
                            <ul className="list-disc space-y-1 pl-5">
                                {soleSites.map(site => <li key={site.id}>{site.name}</li>)}
                            </ul>
                        </>
                    )}
                    {sharedSites.length > 0 && (
                        <>
                            <p>Your membership on these shared sites and any TRMNL display you connected. These sites and their history stay available to the other members:</p>
                            <ul className="list-disc space-y-1 pl-5">
                                {sharedSites.map(site => <li key={site.id}>{site.name}</li>)}
                            </ul>
                        </>
                    )}
                </SectionCard>
                <SectionCard title="What deleting does not change" bodyClassName="space-y-4 text-sm">
                    <p>Your Powerwall and your Tesla account keep working as they do now.</p>
                    <p>Backups can keep deleted data for up to about 8 weeks, until they expire. Service logs can keep technical details until they expire.</p>
                    <p>If you use the iPhone app, its saved data clears the next time it opens. Any solar layout saved to your private iCloud stays there until you remove it in your iPhone&apos;s iCloud settings.</p>
                    <p>If you use TRMNL, remove the pwusage plugin in TRMNL. It stops receiving data once your account is deleted.</p>
                    <p>Signing in with Tesla later creates a new, empty pwusage account.</p>
                </SectionCard>
                <SectionCard title="Confirm">
                    <AccountDeleteForm />
                </SectionCard>
            </div>
        </PageShell>
    );
});
```

Create `cmd/next-app/src/app/account-delete/cancel/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { accountFingerprint, logEvent, observeRoute } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/** Records the Cancel click for the deletion funnel, then returns to the profile page. */
async function handleGET(request: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser();
    if (user) {
        logEvent('info', 'user.account-deletion.cancelled', { accountId: accountFingerprint(user.id) });
    }
    return NextResponse.redirect(new URL('/profile', request.url), 303);
}

export const GET = observeRoute('/account-delete/cancel', handleGET);
```

Create `cmd/next-app/src/app/account-delete/done/page.tsx`:

```typescript
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { getAppBaseUrl } from '@/lib/url-utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Account Deleted | Powerwall Usage',
    robots: { index: false, follow: false },
};

function teslaRevokeUrl(): string | null {
    const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID?.trim();
    if (!clientId) return null;
    const params = new URLSearchParams({
        revoke_client_id: clientId,
        back_url: `${getAppBaseUrl()}/account-delete/done`,
    });
    return `https://auth.tesla.com/user/revoke/consent?${params}`;
}

// Public on purpose: the session is gone by the time this renders, so it cannot tell
// whether a deletion really happened. It stays general and shows no account details.
export default function AccountDeleteDonePage() {
    const revokeUrl = teslaRevokeUrl();
    return (
        <PageShell maxWidth="lg">
            <PageHeader
                title="Account Deleted"
                description="Your pwusage account has been deleted."
                className="mb-6"
            />
            <div className="space-y-6">
                <SectionCard title="Optional: remove pwusage from your Tesla account" bodyClassName="space-y-4 text-sm">
                    <p>pwusage no longer has your Tesla sign-in details, but your Tesla account may still list pwusage as an app you approved. You can remove it at any time.</p>
                    {revokeUrl ? (
                        <a href={revokeUrl}>
                            <Button renderAs="span" variant="outline">Remove pwusage from Tesla</Button>
                        </a>
                    ) : (
                        <p>You can do this in your Tesla account&apos;s third-party app settings.</p>
                    )}
                </SectionCard>
                <SectionCard title="What happens next" bodyClassName="space-y-4 text-sm">
                    <p>Backups can keep deleted data for up to about 8 weeks, until they expire.</p>
                    <p>If you use the iPhone app, its saved data clears the next time it opens. Any solar layout saved to your private iCloud stays there until you remove it in your iPhone&apos;s iCloud settings.</p>
                    <p>If you use TRMNL, remove the pwusage plugin in TRMNL.</p>
                    <p>
                        Questions? Visit the <Link href="/support" className="text-primary underline">support page</Link>.
                    </p>
                </SectionCard>
            </div>
        </PageShell>
    );
}
```

- [ ] **Step 5: Run them and confirm they pass**

```bash
npm test -- --run src/lib/account-deletion-request.test.ts src/app/account-delete
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Button.tsx src/lib/account-deletion-request.ts src/lib/account-deletion-request.test.ts src/components/account src/app/account-delete
git commit -m "feat(web): add the account deletion pages"
```

---

### Task 6: Entry points, privacy and docs

**Files:**
- Modify: `cmd/next-app/src/app/profile/page.tsx`
- Modify: `cmd/next-app/src/app/products/page.tsx`
- Modify: `cmd/next-app/src/app/no-sites/page.tsx`
- Modify: `cmd/next-app/src/app/robots.ts` and `robots.test.ts`
- Modify: `cmd/next-app/src/app/sitemap.ts`
- Modify: `cmd/next-app/src/app/privacy/page.tsx`
- Modify: `cmd/next-app/src/app/support/page.tsx`
- Modify: `Authentication.md`

- [ ] **Step 1: Add the links on `/profile`, `/products` and `/no-sites`**

Change `cmd/next-app/src/app/profile/page.tsx`:

```diff
@@ -156,6 +156,16 @@ export default observePage('/profile', async function ProfilePage() {
 
                 </div>
             </SectionCard>
+
+            <SectionCard
+                className="mt-6"
+                title="Delete Account"
+                description="Permanently delete your pwusage account and sole-member sites."
+            >
+                <Link href="/account-delete" prefetch={false}>
+                    <Button renderAs="span" variant="danger">Delete Account</Button>
+                </Link>
+            </SectionCard>
         </PageShell>
     );
 });
```

Change `cmd/next-app/src/app/products/page.tsx`:

```diff
@@ -5,6 +5,7 @@ import { getAuthorizedSiteIds, getCurrentUser, hasValidSession } from '@/lib/aut
 import { SiteRepo } from '@/lib/site-repo';
 import { DashboardCards, ProductWithLiveData } from '@/components/DashboardCards';
 import { createTeslaClientForUser } from '@/lib/tesla-client-factory';
+import Link from 'next/link';
 import { NoSupportedProducts } from '@/components/NoSupportedProducts';
 import { NoPowerwallYet } from '@/components/no-powerwall-yet';
 import { PageHeader } from '@/components/ui/PageHeader';
@@ -115,6 +116,11 @@ export default observePage('/products', async function ProductsPage({ searchPara
                 ) : (
                     <NoSupportedProducts />
                 )}
+                {!hasEnergyProducts && (
+                    <p className="text-sm text-muted-foreground">
+                        Not planning to use pwusage? <Link href="/account-delete" prefetch={false} className="text-primary underline">Delete your account</Link>.
+                    </p>
+                )}
             </div>
         </PageShell>
     );
```

Change `cmd/next-app/src/app/no-sites/page.tsx`:

```diff
@@ -10,5 +10,8 @@ export default function NoSitesPage() {
             <P>Tesla sign-in succeeded, but this account no longer has access to a Powerwall site.</P>
             <P>If someone removed your access in Tesla, ask them to add you again. Then sign in to pwusage.</P>
             <Link href="/login" className="underline">Sign in with another Tesla account</Link>
+            <P className="text-sm text-muted-foreground">
+                Not planning to use pwusage? <Link href="/login?callback=/account-delete" prefetch={false} className="text-primary underline">Delete your account</Link>.
+            </P>
         </PageShell>
     );
 }
```

- [ ] **Step 2: Keep the page out of crawlers, test first**

Change `cmd/next-app/src/app/robots.test.ts`:

```diff
@@ -16,7 +16,7 @@ describe('robots', () => {
     const rule = robots().rules;
     const disallow = Array.isArray(rule) ? rule[0].disallow : rule.disallow;
     expect(disallow).toEqual(
-      expect.arrayContaining(['/api/', '/admin/', '/profile/', '/logout/'])
+      expect.arrayContaining(['/api/', '/admin/', '/profile/', '/logout/', '/account-delete'])
     );
   });
 
```

```bash
npm test -- --run src/app/robots.test.ts
```

Expected: FAIL. Then:

Change `cmd/next-app/src/app/robots.ts`:

```diff
@@ -8,7 +8,7 @@ export default function robots(): MetadataRoute.Robots {
   return {
     rules: {
       userAgent: '*',
-      disallow: ['/api/', '/admin/', '/profile/', '/logout/'],
+      disallow: ['/api/', '/admin/', '/profile/', '/logout/', '/account-delete'],
     },
     sitemap: `${baseUrl}/sitemap.xml`,
   };
```

Change `cmd/next-app/src/app/sitemap.ts`:

```diff
@@ -5,7 +5,7 @@ import { getAppBaseUrl } from '@/lib/url-utils';
 //   /products — redirects anonymous visitors to /login (auth-gated)
 //   /login    — an OAuth action handler (302s to Tesla), not content
 //   /help     — has no page; the real help page lives at /help/trmnl
-// Auth-gated areas (/site, /admin, /profile) and /api are also excluded and
+// Auth-gated areas (/site, /admin, /profile, /account-delete) and /api are also excluded and
 // disallowed in robots.ts.
 const PUBLIC_PATHS = ['', '/about', '/ios', '/news', '/help/trmnl', '/privacy', '/support'];
 
```

- [ ] **Step 3: Update the privacy policy, support page and auth docs**

Change `cmd/next-app/src/app/privacy/page.tsx`:

```diff
@@ -13,7 +13,7 @@ export const metadata: Metadata = {
 export default function PrivacyPage() {
     return (
         <PageShell maxWidth="lg" padding="default" fullHeight={false}>
-            <PageHeader title="Privacy Policy" description="For the pwusage website and iOS app. Updated November 8, 2026." className="mb-8" />
+            <PageHeader title="Privacy Policy" description="For the pwusage website and iOS app. Updated November 10, 2026." className="mb-8" />
             <div className="space-y-6 text-gray-700 dark:text-gray-300">
                 <p>pwusage helps you understand your Powerwall energy use, estimate electricity costs, and use the optional Battery Saver feature for your Powerwall. This policy explains what information those features use.</p>
                 <SectionCard title="Tesla account and energy information" bodyClassName="space-y-4">
@@ -34,12 +34,13 @@ export default function PrivacyPage() {
                 </SectionCard>
                 <SectionCard title="TRMNL integration" bodyClassName="space-y-4">
                     <p>If you install a TRMNL integration, pwusage shares the dashboard information needed to render your connected display. Our server stores your TRMNL OAuth access token, account and installation identifiers, display settings, and account information supplied by TRMNL, including your email address. We use these records to connect your display, authenticate integration requests, and maintain its settings. If your pwusage account has no email address, we may fill it from the email supplied by TRMNL.</p>
-                    <p>Installation records remain until deleted. When you uninstall the integration through TRMNL and pwusage receives and verifies its uninstall notification, we delete the installation record, including its stored token and TRMNL account information. This does not delete your pwusage account, an email copied to that account, or energy history. If an uninstall does not reach pwusage, or you want other associated data deleted, email support@fm.rodeo. Backups may retain deleted records until their normal expiration.</p>
+                    <p>Installation records remain until deleted. When you uninstall the integration through TRMNL and pwusage receives and verifies its uninstall notification, we delete the installation record, including its stored token and TRMNL account information. This does not delete your pwusage account, an email copied to that account, or energy history. Deleting your pwusage account also deletes the installation records you created. If an uninstall does not reach pwusage, or you want other associated data deleted, email support@fm.rodeo. Backups may retain deleted records until their normal expiration.</p>
                 </SectionCard>
                 <SectionCard title="Retention and your choices" bodyClassName="space-y-4">
                     <p>Server data can remain after you sign out or uninstall the app. Energy history is subject to service retention settings; account records, rate plan history, and backups have separate lifecycles. Signing out is not a request to delete your account.</p>
                     <p>You can revoke pwusage&apos;s access in your Tesla account&apos;s third-party app settings. Revoking Tesla access prevents future authorized API requests but does not automatically erase previously stored data.</p>
-                    <p>To request access, correction, or deletion of your pwusage account and associated data, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership. Backups may retain removed data until their normal expiration.</p>
+                    <p>You can permanently delete your pwusage account, your TRMNL records, and any sites where you are the only member (with their energy history, rate plans, and settings) at any time from <Link href="/account-delete" prefetch={false} className="text-primary underline">Delete Account</Link>. Sites shared with another member stay available to them, including their history. Deleting your account does not remove pwusage from your Tesla account&apos;s approved apps; we offer a link to do that after deletion. It also does not remove any solar layout in your private iCloud, which you can remove in your iPhone&apos;s iCloud settings. Backups may retain removed data until their normal expiration, and operational logs until they expire.</p>
+                    <p>To request access or correction of your data, or if you cannot sign in to delete your account, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership.</p>
                 </SectionCard>
                 <SectionCard title="Privacy questions and changes" bodyClassName="space-y-4">
                     <p>Email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a> with privacy questions. You can also visit our <Link href="/support" className="text-primary underline">support page</Link>. Material changes will be reflected on this page with an updated date.</p>
```

Change `cmd/next-app/src/app/support/page.tsx`:

```diff
@@ -38,7 +38,7 @@ export default function SupportPage() {
                     <p>Solar forecasts are built in and automatic. The app estimates your rooftop solar production using your household usage history and weather reports, with no external account or API key required. If a solar forecast is unavailable or your panel layout is still being determined, Smart Shift falls back to your historical solar production patterns.</p>
                 </SectionCard>
                 <SectionCard title="Account and privacy requests" bodyClassName="space-y-4">
-                    <p>For an account-data or deletion request, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership before acting on your request. Signing out or uninstalling does not delete your server account. Revoking access in Tesla stops future authorized requests.</p>
+                    <p>To delete your account, go to <Link href="/account-delete" prefetch={false} className="text-primary underline">Delete Account</Link>. For other account-data requests, or if you cannot sign in, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. We may need to verify account ownership before acting on your request. Signing out or uninstalling does not delete your server account. Revoking access in Tesla stops future authorized requests.</p>
                     <p>Read our <Link href="/privacy" className="text-primary underline">privacy policy</Link> for details about account information, energy history, and local app data.</p>
                 </SectionCard>
                 <SectionCard title="TRMNL display help">
```

Change `Authentication.md`:

```diff
@@ -389,6 +389,28 @@ Sign out everywhere — Route: `POST /api/auth/sign-out-everywhere`
   refuses to renew the cookie. Re-authentication issues a token stamped with the
   new version. The caller's cookie is cleared in the same response.
 
+### 6. Account deletion
+Page: `/account-delete` (signed-out visitors go through `/login?callback=/account-delete`;
+`/auth/tesla-callback` issues a `site_auth` cookie for that callback even when the
+account has 0 Powerwall sites).
+Route: `DELETE /api/user`
+- Requires an authenticated user and `{ "confirm": "DELETE" }`, with the same
+  origin/`sec-fetch-site` checks as sign-out-everywhere (`isCrossOriginRequest`).
+- Restores any active Battery Saver session on sites where no other usable member
+  remains, because deleting the last member removes the record the restore relies
+  on. If Tesla needs reconnecting or the restore cannot be confirmed, it returns
+  `409`, keeps the account and keeps the session.
+- Deletes in one transaction (`AccountDeletionRepo`), locking the `User` and `Site`
+  rows in deterministic `ORDER BY id` order so a new Battery Saver session cannot
+  slip in. Removes the user's `MobileLoginHandoff`, `TrmnlInstallation`
+  (`installed_by_user_id`), and `SiteMember` rows; for sites with no remaining
+  members, `EnergyDayArchive` goes first (because `EnergyDaySummary` has `NO ACTION`
+  keys to `Tariff` and `TariffSchedule`) followed by `Site`, and finally `User`.
+  Surviving shared sites repair their Tesla connection (`SiteRepo.repairConnection`).
+- Clears the caller's `site_auth` cookie. Other devices are rejected on their next
+  request, because `resolveAuth` no longer finds the user.
+- Does not call Tesla to revoke tokens: Tesla documents no revocation endpoint for third
+  parties. `/account-delete/done` links to Tesla's consent page
+  (`auth.tesla.com/user/revoke/consent`) as an optional step. Revoking must follow
+  deletion, since pwusage needs the grant to restore the reserve.
+
 ### Troubleshooting: "passkey failed" on auth.tesla.com
 
 Tesla supports passkeys as an account sign-in credential. A passkey that a
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- --run src/app/robots.test.ts src/app/sitemap.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/profile/page.tsx src/app/products/page.tsx src/app/no-sites/page.tsx src/app/robots.ts src/app/robots.test.ts src/app/sitemap.ts src/app/privacy/page.tsx src/app/support/page.tsx ../../Authentication.md
git commit -m "feat(web): link to account deletion and update the privacy policy"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run every check, in this order**

```bash
npm run lint
npm run typecheck
npm test -- --run
npm run test:hold:postgres
npm run build
```

Expected: no lint warnings and everything passes.

- [ ] **Step 2: Check the pages in a browser**

Use the preview tools with `npm run dev:agent` on port 5174. Do not submit the form against any database you care about.

- `/account-delete/done` renders in light and dark mode at phone and desktop widths.
- `/account-delete` signed out redirects to `/login?callback=/account-delete`.
- Signed in, if a session is available: the Delete Account card shows on `/profile`, the button stays disabled until `DELETE` is typed exactly, and Cancel returns to `/profile`.

- [ ] **Step 3: Hand the live checks to the owner**

These need live Tesla access, so list them in the PR rather than running them. Use a throwaway account on beta, never the owner's real account:

- A real deletion removes the account, and other signed-in devices are rejected.
- On a shared site, deleting one member's account leaves the site and its history working for the remaining member.
- With Battery Saver on (and no other usable member), the warning shows the right reserve, and deleting restores it on the Powerwall.
- With Tesla disconnected and Battery Saver on (and no other usable member), deletion is refused and the account stays.
- The Tesla removal link works and `back_url` returns to `/account-delete/done`. If Tesla does not return, the page still has to make sense.
- The migration ran on the Dev copy without an orphan-row failure.

- [ ] **Step 4: Mark the PR ready only after those checks**
