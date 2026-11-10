# Orphaned Site and Historical Data Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically clean up departed members, decouple transferred Powerwall hardware IDs, and purge memberless `Site` rows and their historical data after a 30-day retention window.

**Spec:** [`docs/superpowers/specs/2026-11-10-orphaned-site-cleanup-design.md`](../specs/2026-11-10-orphaned-site-cleanup-design.md). Read it first.

**Architecture:** `Site` gains `orphaned_at TIMESTAMPTZ`. Removing a site's last member sets `orphaned_at = COALESCE(orphaned_at, now())` and clears `tesla_hardware_id = NULL` if another `Site` with that hardware ID already has a member. Creating a fresh `Site` with a hardware ID also clears `tesla_hardware_id = NULL` and sets `orphaned_at = COALESCE(orphaned_at, now())` on any memberless `Site` sharing that hardware ID. `SiteMembershipService.resolveProduct` immediately calls `removeMemberIfMissing` when a live `getProducts()` check omits an existing member's mapped ID. `SiteRepo.removeDeadMember` and `reconcileDueMemberships` extend their survivor check so a 14-day-dead membership is removed when a live survivor exists either on the same `site_id` or on another `Site` sharing the same `tesla_hardware_id`. Finally, `reconcileDueMemberships` calls `SiteRepo.purgeOrphanedSites`, which deletes `EnergyDayArchive` and then `Site` for memberless sites whose `orphaned_at` is older than 30 days.

**Tech Stack:** Next.js 16 App Router, TypeScript, PostgreSQL (`pg`), Vitest 4.

## Global Constraints

- Run commands from `cmd/next-app`.
- **Sequencing:** Start implementation only after `feat/user-account-deletion` (`20261110084828_user_account_deletion_cascades.sql`) lands on `main`, since `purgeOrphanedSites` relies on `TrmnlInstallation_site_id_fkey ON DELETE CASCADE`.
- **Never run tests against `.env` or `DATABASE_URL`.** The Postgres suite (`./scripts/test-site-membership.sh`) uses a disposable local cluster.
- Use `npm run db:migration:create add_site_orphaned_at`. Never create a migration file by hand.
- No `any`. Follow `docs/voice-and-terms.md`.

---

### Task 1: Migration, Orphan Stamping, Cross-Site Dead-Member Survivor & 30-Day Purge

**Files:**
- Create: `cmd/next-app/db-migrations/<generated>_add_site_orphaned_at.sql`
- Modify: `cmd/next-app/src/lib/site-repo.ts`
- Modify: `cmd/next-app/src/lib/site-membership-join-repo.ts`
- Modify: `cmd/next-app/src/lib/site-membership-postgres.test.ts`

**Interfaces:**
- Produces:
  - `SiteRepo.purgeOrphanedSites(limit?: number): Promise<string[]>`
  - Updated `SiteRepo.removeMemberIfMissing`, `SiteRepo.removeDeadMember`, `SiteRepo.removeSitesMissingFromTesla`, `SiteRepo.assignSiteToUser`
  - Updated `SiteMembershipJoinRepo.commitDecision`

- [ ] **Step 1: Generate the migration file**

Run from `cmd/next-app`:
```bash
npm run db:migration:create add_site_orphaned_at
```

Write the following idempotent SQL into the generated `cmd/next-app/db-migrations/*_add_site_orphaned_at.sql` file:

```sql
-- Migration: add_site_orphaned_at
-- Tracks when a Site loses its last member so reconcileDueMemberships can purge
-- orphaned sites and their archives after 30 days.

ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "Site_orphaned_at_idx"
    ON "Site"(orphaned_at)
    WHERE orphaned_at IS NOT NULL;

UPDATE "Site" s
SET orphaned_at = now(),
    tesla_hardware_id = CASE
        WHEN s.tesla_hardware_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM "Site" other
            JOIN "SiteMember" m ON m.site_id = other.id
            WHERE other.id <> s.id AND other.tesla_hardware_id = s.tesla_hardware_id
        ) THEN NULL
        ELSE s.tesla_hardware_id
    END
WHERE s.orphaned_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id);
```

- [ ] **Step 2: Write the failing Postgres tests in `cmd/next-app/src/lib/site-membership-postgres.test.ts`**

In `cmd/next-app/src/lib/site-membership-postgres.test.ts`:
1. In `beforeAll`, apply `20261110084828_user_account_deletion_cascades.sql` and the new `*_add_site_orphaned_at.sql` migration (twice, to verify idempotence).
2. Add tests covering:
   - Stamping `orphaned_at` when the last member leaves via `removeMemberIfMissing`, clearing `orphaned_at` on `rejoined-retained`, and decoupling `tesla_hardware_id` when a fresh site is created for the same hardware.
   - `removeDeadMember` removing a 14-day-dead sole member of `s1` when another site `s2` with the same `tesla_hardware_id` has a live member seen within 2 days, stamping `s1.orphaned_at` and clearing `s1.tesla_hardware_id`.
   - `purgeOrphanedSites` deleting `EnergyDayArchive`, `EnergyDaySummary`, `TrmnlInstallation`, `LoadTag`, `BatteryHold`, and `Site` only when `orphaned_at < now() - interval '30 days'`, no `SiteMember` exists, and no active `BatteryHoldStartClaim` exists.

```typescript
  it('stamps orphaned_at when the last member leaves, clears it on rejoin, and decouples hardware on fresh site creation', async () => {
    const sites = new SiteRepo();
    const joins = new SiteMembershipJoinRepo();
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      await local.database.query(`DELETE FROM "Site" WHERE id = 's2'`);
      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', new Date(Date.now() + 60_000))).toBe(true);
      const orphaned = (await local.database.query<{ orphaned_at: Date | null; tesla_hardware_id: string | null }>(
        `SELECT orphaned_at, tesla_hardware_id FROM "Site" WHERE id = 's1'`)).rows[0];
      expect(orphaned.orphaned_at).toBeInstanceOf(Date);
      expect(orphaned.tesla_hardware_id).toBe('hardware-1');

      const info = { id: 'hardware-1', site_name: 'Home' } as EnergySiteInfo;
      await joins.commitDecision({ userId: 'u1', teslaId: 's1', info,
        hardwareId: 'hardware-1', observedMembers: [], verifiedSiteId: null, fetchedAt: new Date() });
      const rejoined = (await local.database.query<{ orphaned_at: Date | null }>(
        `SELECT orphaned_at FROM "Site" WHERE id = 's1'`)).rows[0];
      expect(rejoined.orphaned_at).toBeNull();

      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', new Date(Date.now() + 120_000))).toBe(true);
      const fresh = await joins.commitDecision({ userId: 'u2', teslaId: 'buyer-site', info,
        hardwareId: 'hardware-1', observedMembers: [], verifiedSiteId: null, fetchedAt: new Date() });
      expect(fresh).toEqual({ kind: 'fresh', siteId: 'buyer-site' });
      const decoupled = (await local.database.query<{ orphaned_at: Date | null; tesla_hardware_id: string | null }>(
        `SELECT orphaned_at, tesla_hardware_id FROM "Site" WHERE id = 's1'`)).rows[0];
      expect(decoupled.orphaned_at).toBeInstanceOf(Date);
      expect(decoupled.tesla_hardware_id).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('removes a dead sole member when another site with the same hardware has a live survivor', async () => {
    const sites = new SiteRepo();
    await local.database.query(`UPDATE "User" SET auth_status = 'revoked',
      auth_lost_at = now() - interval '15 days' WHERE id = 'u1'`);
    await local.database.query(`UPDATE "SiteMember" SET last_seen_in_tesla_at = now() - interval '15 days'
      WHERE site_id = 's1' AND user_id = 'u1'`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      // s2 shares hardware-1 and u2 was seen recently, so u1 on s1 can be cleaned up.
      expect(await sites.removeDeadMember('s1', 'u1', 's1')).toBe(true);
      const s1 = (await local.database.query<{ orphaned_at: Date | null; tesla_hardware_id: string | null }>(
        `SELECT orphaned_at, tesla_hardware_id FROM "Site" WHERE id = 's1'`)).rows[0];
      expect(s1.orphaned_at).toBeInstanceOf(Date);
      expect(s1.tesla_hardware_id).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('purges memberless sites orphaned for more than 30 days along with archives and summaries', async () => {
    const sites = new SiteRepo();
    await local.database.query(`DELETE FROM "SiteMember" WHERE site_id = 's1'`);
    await local.database.query(`UPDATE "Site" SET user_id = NULL, tesla_connection_user_id = NULL,
      tesla_hardware_id = NULL, orphaned_at = now() - interval '31 days' WHERE id = 's1'`);
    const archive = await local.database.query<{ id: number }>(
      `INSERT INTO "EnergyDayArchive" (site_id, sample_count, status) VALUES ('s1', 12, 'complete') RETURNING id`);
    await local.database.query(
      `INSERT INTO "EnergyDaySummary" (site_id, archive_id) VALUES ('s1', $1)`, [archive.rows[0].id]);
    await local.database.query(`INSERT INTO "TrmnlInstallation" (site_id) VALUES ('s1')`);
    await local.database.query(`INSERT INTO "LoadTag" (site_id) VALUES ('s1')`);

    // A site with an active start claim is skipped until the claim expires.
    await local.database.query(`INSERT INTO "BatteryHoldStartClaim" (claim_key, owner, expires_at)
      VALUES ('site:s1', $1, now() + interval '1 minute')`, [randomUUID()]);
    expect(await sites.purgeOrphanedSites()).toEqual([]);

    await local.database.query(`DELETE FROM "BatteryHoldStartClaim" WHERE claim_key = 'site:s1'`);
    expect(await sites.purgeOrphanedSites()).toEqual(['s1']);
    expect((await local.database.query(`SELECT id FROM "Site" WHERE id = 's1'`)).rows).toHaveLength(0);
    expect((await local.database.query(`SELECT id FROM "EnergyDayArchive" WHERE site_id = 's1'`)).rows).toHaveLength(0);
    expect((await local.database.query(`SELECT id FROM "EnergyDaySummary" WHERE site_id = 's1'`)).rows).toHaveLength(0);
  });
```

- [ ] **Step 3: Run the Postgres test suite to verify the new tests fail**

Run from `cmd/next-app`:
```bash
./scripts/test-site-membership.sh
```
Expected: FAIL (`orphaned_at` not set / `purgeOrphanedSites` not defined).

- [ ] **Step 4: Implement orphan tracking, hardware decoupling, cross-site survivor check, and `purgeOrphanedSites`**

In `cmd/next-app/src/lib/site-repo.ts`:
1. In `assignSiteToUser`: update the `"Site"` update statement to clear `orphaned_at = NULL`:
   ```typescript
   await client.query('UPDATE "Site" SET user_id = $1, tesla_connection_user_id = $1, orphaned_at = NULL WHERE id = $2', [userId, siteId]);
   ```
2. In `removeSitesMissingFromTesla`: set `orphaned_at` when no member remains:
   ```typescript
   UPDATE "Site" s SET
       user_id = CASE WHEN s.user_id = $1 THEN NULL ELSE s.user_id END,
       orphaned_at = CASE
           WHEN NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)
           THEN COALESCE(s.orphaned_at, now())
           ELSE s.orphaned_at
       END
   FROM removed r
   WHERE s.id = r.site_id
   RETURNING s.id AS site_id
   ```
3. In `removeMember`:
   - Update `removalCondition`'s `EXISTS` survivor check for `deadGrant` so a live survivor on the same `site_id` OR another `"Site"` with the same non-null `tesla_hardware_id` qualifies:
     ```typescript
     AND EXISTS (SELECT 1 FROM "Site" self
         JOIN "Site" other_site ON other_site.id = self.id
             OR (self.tesla_hardware_id IS NOT NULL AND other_site.tesla_hardware_id = self.tesla_hardware_id)
         JOIN "SiteMember" other ON other.site_id = other_site.id
         JOIN "User" survivor ON survivor.id = other.user_id
         WHERE self.id = $1 AND other.user_id <> $2
           AND other.last_seen_in_tesla_at >= now() - interval '2 days'
           AND survivor.is_active = true AND NULLIF(survivor.refresh_token, '') IS NOT NULL
           AND survivor.auth_status IS DISTINCT FROM 'revoked'
           AND survivor.tesla_refresh_state IS DISTINCT FROM 'uncertain'
           AND survivor.tesla_refresh_state IS DISTINCT FROM 'reconnect_required')
     ```
   - Inside `if (result.rowCount === 1)`, after cancelling any active hold when no members remain, stamp `orphaned_at` and decouple `tesla_hardware_id` if another site with that hardware has a member:
     ```typescript
     await client.query(`UPDATE "Site" s
         SET orphaned_at = COALESCE(s.orphaned_at, now()),
             tesla_hardware_id = CASE
                 WHEN s.tesla_hardware_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM "Site" other
                     JOIN "SiteMember" m ON m.site_id = other.id
                     WHERE other.id <> s.id AND other.tesla_hardware_id = s.tesla_hardware_id
                 ) THEN NULL
                 ELSE s.tesla_hardware_id
             END
         WHERE s.id = $1
           AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)`, [siteId]);
     ```
4. Add `purgeOrphanedSites(limit = 20): Promise<string[]>` to `SiteRepo`:
   ```typescript
   async purgeOrphanedSites(limit = 20): Promise<string[]> {
       const client = await pool.connect();
       let purgedIds: string[] = [];
       try {
           await client.query('BEGIN');
           const eligible = await client.query<{ id: string }>(`
               SELECT s.id
               FROM "Site" s
               WHERE s.orphaned_at < now() - interval '30 days'
                 AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)
                 AND NOT EXISTS (
                     SELECT 1 FROM "BatteryHoldStartClaim" c
                     WHERE c.claim_key = COALESCE(s.tesla_hardware_id, 'site:' || s.id)
                       AND c.expires_at > clock_timestamp()
                 )
               ORDER BY s.id
               LIMIT $1
               FOR UPDATE
           `, [limit]);
           purgedIds = eligible.rows.map(row => row.id);
           if (purgedIds.length > 0) {
               await client.query('DELETE FROM "EnergyDayArchive" WHERE site_id = ANY($1::text[])', [purgedIds]);
               await client.query('DELETE FROM "Site" WHERE id = ANY($1::text[])', [purgedIds]);
           }
           await client.query('COMMIT');
       } catch (error) {
           await client.query('ROLLBACK');
           throw error;
       } finally {
           client.release();
       }
       for (const id of purgedIds) this.invalidateCache(id);
       if (purgedIds.length > 0) {
           logEvent('info', 'site.orphaned.purged', { purgedCount: purgedIds.length, siteIds: purgedIds });
       }
       return purgedIds;
   }
   ```

In `cmd/next-app/src/lib/site-membership-join-repo.ts`:
1. In `commitDecision` when `verifiedSiteId` is non-null: clear `orphaned_at = NULL` on `verifiedSiteId`.
2. In `commitDecision` when rejoining `retained`: include `orphaned_at = NULL` in the `UPDATE "Site"` statement.
3. In `commitDecision` when creating a `fresh` site: if `hardwareId` is non-null, decouple any memberless `"Site"` rows that still carry `tesla_hardware_id = hardwareId`:
   ```typescript
   if (hardwareId) {
       await client.query(`UPDATE "Site" s
           SET tesla_hardware_id = NULL,
               orphaned_at = COALESCE(s.orphaned_at, now())
           WHERE s.tesla_hardware_id = $1
             AND s.id <> $2
             AND NOT EXISTS (SELECT 1 FROM "SiteMember" m WHERE m.site_id = s.id)`,
       [hardwareId, teslaId]);
   }
   ```

- [ ] **Step 5: Run `./scripts/test-site-membership.sh` to verify Task 1 passes**

Run from `cmd/next-app`:
```bash
./scripts/test-site-membership.sh
```
Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add cmd/next-app/db-migrations/*_add_site_orphaned_at.sql cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-membership-join-repo.ts cmd/next-app/src/lib/site-membership-postgres.test.ts
git commit -m "feat(db): track and purge orphaned sites after 30 days"
```

---

### Task 2: Immediate Removal on Live `resolveProduct` Check & Daily Cron Integration

**Files:**
- Modify: `cmd/next-app/src/lib/site-membership-service.ts`
- Modify: `cmd/next-app/src/lib/site-membership-service.test.ts`
- Modify: `cmd/next-app/src/lib/site-membership-daily.ts`
- Modify: `cmd/next-app/src/lib/site-membership-postgres.test.ts`

**Interfaces:**
- Consumes: `SiteRepo.removeMemberIfMissing`, `SiteRepo.purgeOrphanedSites`
- Produces: `reconcileDueMemberships(deadlineMs: number): Promise<{ checked: number; failed: number; deadRemoved: number; orphanedPurged: number }>`

- [ ] **Step 1: Write the failing unit and Postgres tests**

In `cmd/next-app/src/lib/site-membership-service.test.ts`, add:
```typescript
    it('immediately removes an observed member whose live product list omits their mapped site', async () => {
        const departed = { site_id: 'old-home', user_id: 'seller', tesla_energy_site_id: '10',
            is_active: true, refresh_token: 'r', auth_status: 'active', tesla_refresh_state: 'ready' };
        members.membersForHardware.mockResolvedValueOnce([departed]).mockResolvedValueOnce([]);
        members.commitDecision.mockResolvedValue({ kind: 'fresh', siteId: '20' });
        clientForUser.mockResolvedValue({ getProducts: async () => [] });

        expect(await service().syncLogin('buyer', [product(20)], fetchedAt)).toEqual(['20']);
        expect(sites.removeMemberIfMissing).toHaveBeenCalledWith('old-home', 'seller', '10', expect.any(Date));
        expect(members.commitDecision).toHaveBeenCalledWith(expect.objectContaining({
            verifiedSiteId: null, observedMembers: [], teslaId: '20', hardwareId: 'hardware-1',
        }));
        expect(importer.ensureSite).toHaveBeenCalledWith('20');
    });
```

In `cmd/next-app/src/lib/site-membership-postgres.test.ts` (`describe('daily membership reconciliation')`), add a test verifying that `reconcileDueMemberships` removes a dead member on `s1` when `s2` has a live survivor with the same `tesla_hardware_id` and purges sites with `orphaned_at < now() - interval '30 days'`:
```typescript
    it('removes a dead member across shared hardware and purges 30-day orphaned sites', async () => {
      await local.database.query(`UPDATE "User" SET auth_status = 'revoked', auth_lost_at = now() - interval '30 days' WHERE id = 'u1'`);
      await local.database.query(`UPDATE "SiteMember" SET last_seen_in_tesla_at = now() - interval '20 days' WHERE site_id = 's1' AND user_id = 'u1'`);
      await local.database.query(`INSERT INTO "Site" (id, orphaned_at) VALUES ('expired-orphan', now() - interval '31 days')`);
      const result = await reconcileDueMemberships(farFuture());
      expect(result.deadRemoved).toBe(1);
      expect(result.orphanedPurged).toBe(1);
      expect((await local.database.query(`SELECT id FROM "Site" WHERE id = 'expired-orphan'`)).rows).toHaveLength(0);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `cmd/next-app`:
```bash
npx vitest run src/lib/site-membership-service.test.ts
./scripts/test-site-membership.sh
```
Expected: FAIL.

- [ ] **Step 3: Update `SiteMembershipService.resolveProduct` and `reconcileDueMemberships`**

In `cmd/next-app/src/lib/site-membership-service.ts`, update `resolveProduct`:
```typescript
    private async resolveProduct(userId: string, teslaId: string, info: EnergySiteInfo,
        hardwareId: string | null, fetchedAt: Date) {
        for (let attempt = 0; attempt < 2; attempt++) {
            let observedMembers = hardwareId ? await this.members.membersForHardware(hardwareId) : [];
            let verifiedSiteId: string | null = null;
            let removedAny = false;
            let checked = 0;
            for (const member of observedMembers) {
                if (member.user_id === userId || !usable(member)) continue;
                if (checked >= 3) break;
                checked++;
                const client = await this.clientForUser(member.user_id);
                if (!client) throw new Error('Usable site member has no Tesla client');
                const checkedAt = new Date();
                const products = await client.getProducts();
                if (products.some(product => String(product.energy_site_id) === member.tesla_energy_site_id)) {
                    verifiedSiteId = member.site_id;
                    break;
                }
                if (await this.sites.removeMemberIfMissing(member.site_id, member.user_id, member.tesla_energy_site_id, checkedAt)) {
                    removedAny = true;
                }
            }
            if (!verifiedSiteId && removedAny && hardwareId) {
                observedMembers = await this.members.membersForHardware(hardwareId);
            }
            const decision = await this.members.commitDecision({ userId, teslaId, info,
                hardwareId, observedMembers, verifiedSiteId, fetchedAt });
            if (decision.kind !== 'retry') return decision;
        }
        throw new Error('Site membership changed during login');
    }
```

In `cmd/next-app/src/lib/site-membership-daily.ts`:
1. Update the return type of `reconcileDueMemberships` to `Promise<{ checked: number; failed: number; deadRemoved: number; orphanedPurged: number }>` (returning `{ checked: 0, failed: 0, deadRemoved: 0, orphanedPurged: 0 }` when `!siteMembershipEnabled()`).
2. Update the `stale` query's survivor `EXISTS` clause to match `SiteRepo.removeDeadMember`:
   ```sql
   SELECT m.site_id, m.user_id, m.tesla_energy_site_id
   FROM "SiteMember" m
   JOIN "Site" s ON s.id = m.site_id
   JOIN "User" u ON u.id = m.user_id
   WHERE m.last_seen_in_tesla_at < now() - interval '14 days'
     AND u.auth_lost_at < now() - interval '14 days'
     AND (u.is_active IS NOT TRUE OR NULLIF(u.refresh_token, '') IS NULL
          OR u.auth_status = 'revoked'
          OR u.tesla_refresh_state IN ('uncertain', 'reconnect_required'))
     AND EXISTS (SELECT 1 FROM "Site" other_site
         JOIN "SiteMember" other ON other.site_id = other_site.id
         JOIN "User" survivor ON survivor.id = other.user_id
         WHERE (other_site.id = m.site_id
                OR (s.tesla_hardware_id IS NOT NULL AND other_site.tesla_hardware_id = s.tesla_hardware_id))
           AND other.user_id <> m.user_id
           AND other.last_seen_in_tesla_at >= now() - interval '2 days'
           AND survivor.is_active = true AND NULLIF(survivor.refresh_token, '') IS NOT NULL
           AND survivor.auth_status IS DISTINCT FROM 'revoked'
           AND survivor.tesla_refresh_state IS DISTINCT FROM 'uncertain'
           AND survivor.tesla_refresh_state IS DISTINCT FROM 'reconnect_required')
   ORDER BY m.last_seen_in_tesla_at LIMIT 50
   ```
3. After the dead-member cleanup loop, if `Date.now() < deadlineMs - 5_000`, call `const purged = await sites.purgeOrphanedSites(); orphanedPurged = purged.length;` and return `{ checked, failed, deadRemoved, orphanedPurged }`.

- [ ] **Step 4: Run the unit and Postgres tests**

Run from `cmd/next-app`:
```bash
npx vitest run src/lib/site-membership-service.test.ts
./scripts/test-site-membership.sh
```
Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add cmd/next-app/src/lib/site-membership-service.ts cmd/next-app/src/lib/site-membership-service.test.ts cmd/next-app/src/lib/site-membership-daily.ts cmd/next-app/src/lib/site-membership-postgres.test.ts
git commit -m "feat(membership): remove departed members on live check and purge orphaned sites daily"
```

---

### Task 3: Documentation & Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-shared-site-membership-design.md`
- Modify: `DesignDecisions.md`

- [ ] **Step 1: Update `2026-11-08-shared-site-membership-design.md` and `DesignDecisions.md`**

In `docs/superpowers/specs/2026-11-08-shared-site-membership-design.md` (Q3 in section 13):
- Record that memberless sites are stamped with `orphaned_at`, decoupled from `tesla_hardware_id` once another site with that hardware has a member, and purged after 30 days by `reconcileDueMemberships` (linking `2026-11-10-orphaned-site-cleanup-design.md`).

In `DesignDecisions.md`:
- Document why `removeDeadMember` checks for a live survivor across `tesla_hardware_id` (not just `site_id`) and why `purgeOrphanedSites` deletes `EnergyDayArchive` before `Site`.

- [ ] **Step 2: Run full verification in `cmd/next-app`**

```bash
./scripts/test-site-membership.sh
./scripts/test-battery-hold.sh
npm run lint
npm run typecheck
npm test -- --run
npm run build
```
Expected: All suites and build pass with zero errors.

- [ ] **Step 3: Commit Task 3**

```bash
git add docs/superpowers/specs/2026-11-08-shared-site-membership-design.md DesignDecisions.md
git commit -m "docs: record orphaned-site retention and cross-hardware dead-grant cleanup"
```
