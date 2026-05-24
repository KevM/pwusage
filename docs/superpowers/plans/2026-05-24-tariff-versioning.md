# Append-Only Tariff Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tariff content append-only (versioned at the `Tariff` root) so changing a tariff never deletes rows — eliminating both the importer's tariff-ID FK race and the latent `ON DELETE CASCADE` history wipe, and retiring `remapTariffIds`.

**Architecture:** Add `version` + `is_current` (+ `content_hash`) to `Tariff`. `TariffRepo.replaceTariffsForSite` (delete-and-reinsert) becomes `addTariffVersion` (demote current, append a new version, never delete). Reads filter `is_current`; the billing name-resolution map reads all versions. `EnergyData`'s unique key tightens to `(timestamp, site_id)` so re-imports update in place instead of duplicating across versions.

**Tech Stack:** TypeScript, Next.js, PostgreSQL (Supabase), `pg` Pool, Vitest. Migrations are plain SQL in `cmd/next-app/db-migrations/`, applied by `supabase migration up` (each file runs inside a transaction — no `CREATE INDEX CONCURRENTLY`).

**Spec:** `docs/superpowers/specs/2026-05-24-tariff-versioning-design.md`

---

## File structure

- `cmd/next-app/db-migrations/20260524_120000_tariff_versioning.sql` — **new** migration (schema).
- `cmd/next-app/src/lib/importer/tariff-parser.ts` — **modify**: add pure `tariffContentHash(parsed)`.
- `cmd/next-app/src/lib/importer/tariff-parser.test.ts` — **modify (append, do not overwrite)**: unit tests for the hash. This file already has parser tests; preserve them.
- `cmd/next-app/src/lib/tariff-repo.ts` — **modify**: `replaceTariffsForSite` → `addTariffVersion`; keep `getTariffsForSite` (now used as the all-versions map).
- `cmd/next-app/src/lib/tariff-repo.test.ts` — **new**: tests for `addTariffVersion`.
- `cmd/next-app/src/lib/site-repo.ts` — **modify**: `AND t.is_current` on the tariff join.
- `cmd/next-app/src/lib/site-repo.test.ts` — **modify**: assert the join filter.
- `cmd/next-app/src/lib/energy-repo.ts` — **modify**: `(timestamp, site_id)` upsert target; all-versions `tariffMap` in `getUsageByTOU`.
- `cmd/next-app/src/lib/energy-repo.test.ts` — **modify**: upsert-target test; historical-name-resolution test.
- `cmd/next-app/src/lib/importer/index.ts` — **modify**: remove `remapTariffIds` + its two call sites; call `addTariffVersion`.
- `cmd/next-app/src/lib/importer.test.ts` — **modify**: remove the remap `describe` block.
- `TODO.md` — **modify**: remove items #4 and #5.

All commands below run from `cmd/next-app/` unless noted.

---

## Task 1: Schema migration

**Files:**
- Create: `cmd/next-app/db-migrations/20260524_120000_tariff_versioning.sql`

Migrations are Postgres-only. **Do not run DDL against production** — CI applies it on merge. Verify locally against a scratch/local Postgres (or the Supabase local stack).

- [ ] **Step 1: Write the migration**

Create `cmd/next-app/db-migrations/20260524_120000_tariff_versioning.sql`:

```sql
-- Append-only tariff versioning.
-- Root cause being fixed: TariffRepo.replaceTariffsForSite deleted Tariff rows on
-- every tariff-content change. That DELETE cascade-wiped EnergyData (via
-- EnergyData_tariff_id_fkey ON DELETE CASCADE) and orphaned the importer's
-- in-memory tariff snapshot (FK violation, worked around by remapTariffIds).
-- After this change tariffs are append-only: a new version is inserted and the
-- old one is demoted (is_current=false), never deleted.
-- See docs/superpowers/specs/2026-05-24-tariff-versioning-design.md
-- Uses unique INDEXES (not table constraints) so the migration is idempotent
-- (ADD CONSTRAINT has no IF NOT EXISTS); ON CONFLICT can infer a unique index.

-- 1. Tariff: versioning columns.
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- 2. Replace UNIQUE(site_id, name) with version-aware uniqueness + one-current guard.
ALTER TABLE "Tariff" DROP CONSTRAINT IF EXISTS "Tariff_site_id_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS tariff_site_name_version_uidx
    ON "Tariff"(site_id, name, version);
-- Partial index: at most one current version per named tariff. Also doubles as
-- the access path for the SiteRepo read join (t.site_id = s.id AND t.is_current).
CREATE UNIQUE INDEX IF NOT EXISTS tariff_current_uidx
    ON "Tariff"(site_id, name) WHERE is_current;

-- 3. Tighten EnergyData identity to one reading per instant per site.
-- Validated 2026-05-24 against production: 0 (timestamp, site_id) pairs reference
-- more than one tariff_id, so this is a safe, non-lossy swap. tariff_id is
-- retained (still NOT NULL, still used by billing); only the unique key changes.
ALTER TABLE "EnergyData" DROP CONSTRAINT IF EXISTS "EnergyData_timestamp_site_id_tariff_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS energy_ts_site_uidx
    ON "EnergyData"(timestamp, site_id);
```

- [ ] **Step 2: Apply to a local/scratch Postgres and verify**

Run (against a local Postgres — NOT production; substitute your local URL):

```bash
psql "$LOCAL_PG_URL" -f db-migrations/20260524_120000_tariff_versioning.sql
```

Expected: completes without error (`ALTER TABLE` / `CREATE INDEX` notices only).

- [ ] **Step 3: Verify idempotency (re-run)**

Run the exact same command again:

```bash
psql "$LOCAL_PG_URL" -f db-migrations/20260524_120000_tariff_versioning.sql
```

Expected: no errors (every statement is `IF [NOT] EXISTS`-guarded).

- [ ] **Step 4: Verify the resulting schema**

```bash
psql "$LOCAL_PG_URL" -c "\d+ \"Tariff\"" -c "SELECT indexname FROM pg_indexes WHERE tablename IN ('Tariff','EnergyData') ORDER BY 1;"
```

Expected: `Tariff` has `version`, `is_current`, `content_hash`; indexes include
`tariff_site_name_version_uidx`, `tariff_current_uidx`, `energy_ts_site_uidx`;
`EnergyData_timestamp_site_id_tariff_id_key` is gone.

- [ ] **Step 5: Commit**

```bash
git add db-migrations/20260524_120000_tariff_versioning.sql
git commit -m "feat(db): append-only tariff versioning schema"
```

---

## Task 2: `tariffContentHash` pure function

A deterministic, order-independent hash of a parsed tariff. Used by `addTariffVersion` as the idempotency guard (skip appending when content is unchanged).

**Files:**
- Modify: `cmd/next-app/src/lib/importer/tariff-parser.ts`
- Test: `cmd/next-app/src/lib/importer/tariff-parser.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/importer/tariff-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tariffContentHash } from './tariff-parser';
import type { ParsedTariff } from './tariff-parser';

const base: ParsedTariff = {
    name: 'PG&E EV2-A',
    seasons: [
        {
            name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30,
            buy_rate: 0, sell_rate: 0,
            schedules: [
                { name: 'ON_PEAK', buy_rate: 0.5, sell_rate: 0.1, from_day_of_week: 0, to_day_of_week: 6, from_hour: 16, from_minute: 0, to_hour: 21, to_minute: 0 },
                { name: 'OFF_PEAK', buy_rate: 0.3, sell_rate: 0.1, from_day_of_week: 0, to_day_of_week: 6, from_hour: 21, from_minute: 0, to_hour: 16, to_minute: 0 },
            ],
        },
    ],
};

describe('tariffContentHash', () => {
    it('is stable for identical content', () => {
        expect(tariffContentHash(base)).toBe(tariffContentHash(structuredClone(base)));
    });

    it('is independent of schedule ordering', () => {
        const reordered = structuredClone(base);
        reordered.seasons[0].schedules.reverse();
        expect(tariffContentHash(reordered)).toBe(tariffContentHash(base));
    });

    it('changes when a rate changes', () => {
        const changed = structuredClone(base);
        changed.seasons[0].schedules[0].buy_rate = 0.99;
        expect(tariffContentHash(changed)).not.toBe(tariffContentHash(base));
    });

    it('changes when a window boundary changes', () => {
        const changed = structuredClone(base);
        changed.seasons[0].schedules[0].from_hour = 17;
        expect(tariffContentHash(changed)).not.toBe(tariffContentHash(base));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/importer/tariff-parser`
Expected: FAIL — `tariffContentHash is not a function` (not exported yet).

- [ ] **Step 3: Implement the hash**

In `cmd/next-app/src/lib/importer/tariff-parser.ts`, add at the top:

```ts
import { createHash } from 'crypto';
```

and append this exported function at the end of the file:

```ts
/**
 * Deterministic, order-independent content hash of a parsed tariff. Two parses
 * with the same rates/windows/names produce the same hash regardless of the
 * order seasons/schedules arrive in. Used to skip appending a redundant tariff
 * version when content is unchanged.
 */
export function tariffContentHash(parsed: ParsedTariff): string {
    const normalized = {
        name: parsed.name,
        seasons: [...parsed.seasons]
            .map((s) => ({
                name: s.name,
                from_month: s.from_month, from_day: s.from_day,
                to_month: s.to_month, to_day: s.to_day,
                buy_rate: s.buy_rate, sell_rate: s.sell_rate,
                schedules: [...s.schedules]
                    .map((sc) => ({
                        name: sc.name,
                        buy_rate: sc.buy_rate, sell_rate: sc.sell_rate,
                        from_day_of_week: sc.from_day_of_week, to_day_of_week: sc.to_day_of_week,
                        from_hour: sc.from_hour, from_minute: sc.from_minute,
                        to_hour: sc.to_hour, to_minute: sc.to_minute,
                    }))
                    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/importer/tariff-parser`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/importer/tariff-parser.ts src/lib/importer/tariff-parser.test.ts
git commit -m "feat(tariff): add deterministic tariffContentHash"
```

---

## Task 3: `TariffRepo.addTariffVersion` (append-only)

Replace the delete-and-reinsert `replaceTariffsForSite` with an append-only `addTariffVersion`. `getTariffsForSite` is kept unchanged (it has no `is_current` filter, so it already returns all versions — reused as the billing name map in Task 6).

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/tariff-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
    connectMock: vi.fn(),
    clientQueryMock: vi.fn(),
    releaseMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: {
        connect: connectMock,
        query: vi.fn(),
    },
}));

import { TariffRepo } from './tariff-repo';
import type { ParsedTariff } from './importer/tariff-parser';

const parsed: ParsedTariff = {
    name: 'PG&E',
    seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0, sell_rate: 0,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.3, sell_rate: 0.1, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
    }],
};

function sqlOf(call: unknown[]): string {
    return String(call[0]);
}

describe('TariffRepo.addTariffVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    it('appends a new version and demotes the current one, without deleting', async () => {
        // current version has a different content_hash -> not idempotent skip
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: 'STALE' }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: 2 }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 8 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 80 }] };
            return { rows: [] };
        });

        await new TariffRepo().addTariffVersion('site-1', parsed);

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some((s) => s.includes('DELETE FROM'))).toBe(false);
        expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = false'))).toBe(true);
        expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"') && s.includes('is_current'))).toBe(true);
        expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    });

    it('is a no-op when the current version already has the same content_hash', async () => {
        const { tariffContentHash } = await import('./importer/tariff-parser');
        const matching = tariffContentHash(parsed);
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: matching }] };
            return { rows: [] };
        });

        await new TariffRepo().addTariffVersion('site-1', parsed);

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some((s) => s.includes('INSERT INTO "Tariff"'))).toBe(false);
        expect(sqls.some((s) => s.includes('UPDATE "Tariff" SET is_current = false'))).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tariff-repo`
Expected: FAIL — `addTariffVersion is not a function`.

- [ ] **Step 3: Implement `addTariffVersion`**

In `cmd/next-app/src/lib/tariff-repo.ts`, add the import and replace the
`replaceTariffsForSite` method. The new file body:

```ts
import { pool, Tariff } from './db';
import { ParsedTariff, tariffContentHash } from './importer/tariff-parser';

export class TariffRepo {
    // === Queries ===
    // No is_current filter on purpose: returns ALL versions, used by the billing
    // name-resolution map so historical EnergyData rows (which keep an older
    // version's tariff_id) still resolve to a tariff name.
    async getTariffsForSite(siteId: string): Promise<Tariff[]> {
        const res = await pool.query('SELECT id, site_id, name, updated FROM "Tariff" WHERE site_id = $1', [siteId]);
        return res.rows;
    }

    // === Commands ===
    /**
     * Append a new tariff version (Tariff + seasons + schedules) and demote the
     * previous current version. Never deletes — so EnergyData referencing older
     * versions survives and the importer's snapshot can never go stale.
     * No-op when the current version already has identical content.
     */
    async addTariffVersion(siteId: string, parsed: ParsedTariff): Promise<void> {
        const newHash = tariffContentHash(parsed);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Idempotency guard: skip if current version already has this content.
            const currentRes = await client.query(
                'SELECT content_hash FROM "Tariff" WHERE site_id = $1 AND is_current LIMIT 1',
                [siteId]
            );
            if (currentRes.rows[0]?.content_hash === newHash) {
                await client.query('COMMIT');
                return;
            }

            // Demote the current version (no delete).
            await client.query(
                'UPDATE "Tariff" SET is_current = false WHERE site_id = $1 AND is_current',
                [siteId]
            );

            // Next version number for this site.
            const verRes = await client.query(
                'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
                [siteId]
            );
            const version = verRes.rows[0].next;

            // Insert the new version.
            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, updated)
                 VALUES ($1, $2, $3, true, $4, NOW())
                 RETURNING id`,
                [siteId, parsed.name, version, newHash]
            );
            const tariffId = tariffRes.rows[0].id;

            for (const season of parsed.seasons) {
                const seasonRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate]
                );
                const seasonId = seasonRes.rows[0].id;

                for (const schedule of season.schedules) {
                    await client.query(
                        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                        [
                            seasonId, schedule.name, schedule.buy_rate, schedule.sell_rate,
                            schedule.from_day_of_week, schedule.to_day_of_week,
                            schedule.from_hour, schedule.from_minute, schedule.to_hour, schedule.to_minute,
                        ]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
}
```

Delete the old `replaceTariffsForSite` method entirely (the import line at the top changes from `import { pool, Tariff } from './db';` to the two-line import shown above).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/tariff-repo`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff-repo.ts src/lib/tariff-repo.test.ts
git commit -m "feat(tariff): append-only addTariffVersion (replaces replaceTariffsForSite)"
```

---

## Task 4: `SiteRepo` reads only the current version

**Files:**
- Modify: `cmd/next-app/src/lib/site-repo.ts:109`
- Test: `cmd/next-app/src/lib/site-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `describe` to `cmd/next-app/src/lib/site-repo.test.ts`. `queryMock`,
`SiteRepo`, and `beforeEach` are already in scope at the top of this file. The
`invalidateCache` call mirrors the existing tests — it clears the module-level
`siteCache` so the call actually issues the SQL instead of serving a cached site:

```ts
describe('SiteRepo current-version tariff filter', () => {
    beforeEach(() => {
        queryMock.mockReset();
        new SiteRepo().invalidateCache('site-1');
    });

    it('joins only the current tariff version', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await new SiteRepo().getSite('site-1');
        const sql = String(queryMock.mock.calls.at(-1)?.[0] ?? '');
        expect(sql).toContain('LEFT JOIN "Tariff"');
        expect(sql).toContain('t.is_current');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/site-repo`
Expected: FAIL — SQL does not contain `t.is_current`.

- [ ] **Step 3: Add the filter**

In `cmd/next-app/src/lib/site-repo.ts`, change line 109:

```ts
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id
```

to:

```ts
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id AND t.is_current
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/site-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/site-repo.ts src/lib/site-repo.test.ts
git commit -m "feat(site): load only the current tariff version into site.tariffs"
```

---

## Task 5: `EnergyData` upsert keyed on `(timestamp, site_id)`

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts:513-519`
- Test: `cmd/next-app/src/lib/energy-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cmd/next-app/src/lib/energy-repo.test.ts`:

```ts
describe('EnergyRepo.insertEnergyDataBatch conflict target', () => {
    it('upserts on (timestamp, site_id) and refreshes tariff_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await new EnergyRepo().insertEnergyDataBatch([{
            site_id: 'site-1', tariff_id: 2, tariff_schedule_id: 20,
            timestamp: new Date('2026-05-11T07:00:00Z'),
            load_power: 1, solar_power: 2, grid_power: 3, battery_power: 4, battery_soc: 50,
        }]);
        const sql = String(queryMock.mock.calls.at(-1)?.[0] ?? '');
        expect(sql).toContain('ON CONFLICT(timestamp, site_id) DO UPDATE');
        expect(sql).toContain('tariff_id = EXCLUDED.tariff_id');
        expect(sql).not.toContain('ON CONFLICT(timestamp, site_id, tariff_id)');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/energy-repo`
Expected: FAIL — current SQL targets `(timestamp, site_id, tariff_id)` and does not set `tariff_id`.

- [ ] **Step 3: Update the upsert**

In `cmd/next-app/src/lib/energy-repo.ts`, replace the `ON CONFLICT` block (lines 513-519):

```sql
            ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET
                load_power = EXCLUDED.load_power,
                solar_power = EXCLUDED.solar_power,
                grid_power = EXCLUDED.grid_power,
                battery_power = EXCLUDED.battery_power,
                battery_soc = COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
                tariff_schedule_id = EXCLUDED.tariff_schedule_id
```

with:

```sql
            ON CONFLICT(timestamp, site_id) DO UPDATE SET
                tariff_id = EXCLUDED.tariff_id,
                load_power = EXCLUDED.load_power,
                solar_power = EXCLUDED.solar_power,
                grid_power = EXCLUDED.grid_power,
                battery_power = EXCLUDED.battery_power,
                battery_soc = COALESCE(EXCLUDED.battery_soc, "EnergyData".battery_soc),
                tariff_schedule_id = EXCLUDED.tariff_schedule_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/energy-repo`
Expected: PASS (and existing energy-repo tests stay green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/energy-repo.ts src/lib/energy-repo.test.ts
git commit -m "feat(energy): key EnergyData upsert on (timestamp, site_id)"
```

---

## Task 6: Billing name map covers all tariff versions

After Task 4, `site.tariffs` is current-only. The billing read in `getUsageByTOU` builds two things from it: the pricing `Schedule` (correct — current only) and the `tariffMap` used for `tariff_id → name`. Historical `EnergyData` rows keep an older version's `tariff_id`, so the name map must read all versions or those rows resolve to `'Unknown'`.

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts:140-141` (and imports)
- Test: `cmd/next-app/src/lib/energy-repo.test.ts`

- [ ] **Step 1: Write the failing test**

First add these two imports at the **top** of `cmd/next-app/src/lib/energy-repo.test.ts`
(alongside the existing imports — ES module imports cannot be mid-file):

```ts
import { SiteRepo } from './site-repo';
import { TariffRepo } from './tariff-repo';
```

Then append this `describe` block to the same file:

```ts
describe('EnergyRepo.getUsageByTOU historical name resolution', () => {
    it('resolves a tariff_id from an older version to its name (not Unknown)', async () => {
        const repo = new EnergyRepo();

        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', utility: 'PG&E',
            updated: new Date(), installed: new Date('2026-01-01T00:00:00Z'),
            timezone: 'UTC', billing_start_day: 1,
            tariffs: [{ id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date(), seasons: [] }],
        } as never);

        // All versions: current v2 (id 2) plus historical v1 (id 1).
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([
            { id: 1, site_id: 'site-1', name: 'PG&E v1', updated: new Date() },
            { id: 2, site_id: 'site-1', name: 'PG&E v2', updated: new Date() },
        ] as never);

        // One historical aggregate row stamped with the old version's tariff_id (1).
        vi.spyOn(repo, 'getCycleAggregates').mockResolvedValue([{
            day: new Date('2026-02-01T00:00:00Z'),
            tariff_id: 1, tariff_schedule_id: null,
            load_power: 10, solar_power: 0, grid_power: 10, battery_power: 0,
        }] as never);
        vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([] as never);

        const usage = await repo.getUsageByTOU('site-1',
            new Date('2026-02-01T00:00:00Z'), new Date('2026-02-02T00:00:00Z'));

        const row = usage.find((u) => u.tariff?.id === 1);
        expect(row).toBeDefined();
        expect(row!.tariff.name).toBe('PG&E v1');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/energy-repo`
Expected: FAIL — `tariff` is `undefined` / name not `'PG&E v1'` (current-only map lacks id 1).

- [ ] **Step 3: Build the name map from all versions**

In `cmd/next-app/src/lib/energy-repo.ts`, ensure `TariffRepo` is imported near the other repo imports:

```ts
import { TariffRepo } from './tariff-repo';
```

Then change lines 140-141 from:

```ts
        const tariffMap = new Map<number, Tariff>();
        site.tariffs.forEach(t => tariffMap.set(t.id, t));
```

to:

```ts
        // Name-resolution map must cover ALL tariff versions: historical EnergyData
        // rows keep an older version's tariff_id and would otherwise show 'Unknown'.
        // (Pricing still uses site.tariffs — current only — via the Schedule below.)
        const tariffMap = new Map<number, Tariff>();
        const allVersions = await new TariffRepo().getTariffsForSite(siteId);
        allVersions.forEach(t => tariffMap.set(t.id, t));
        site.tariffs.forEach(t => tariffMap.set(t.id, t));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/energy-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/energy-repo.ts src/lib/energy-repo.test.ts
git commit -m "fix(energy): resolve historical tariff_id names across versions"
```

---

## Task 7: Remove the importer remap; wire `addTariffVersion`

With versioning, the importer's snapshot `tariff_id` always still exists, so `remapTariffIds` is dead code.

**Files:**
- Modify: `cmd/next-app/src/lib/importer/index.ts` (remove `remapTariffIds` lines 48-133; its calls at ~170 and ~489; `ensureSite` call at 401)
- Modify: `cmd/next-app/src/lib/importer.test.ts` (remove the `Importer Tariff Remapping` describe, lines 236-360)

- [ ] **Step 1: Remove the remap test block**

In `cmd/next-app/src/lib/importer.test.ts`, delete the entire
`describe('Importer Tariff Remapping', () => { ... });` block (lines 236-360,
ending at the closing `});` on line 360).

- [ ] **Step 2: Point `ensureSite` at `addTariffVersion`**

In `cmd/next-app/src/lib/importer/index.ts`, line 401, change:

```ts
                await this.tariffRepo.replaceTariffsForSite(siteId, parsed);
```

to:

```ts
                await this.tariffRepo.addTariffVersion(siteId, parsed);
```

- [ ] **Step 3: Remove the `remapTariffIds` method**

In `cmd/next-app/src/lib/importer/index.ts`, delete the entire `remapTariffIds`
method including its doc comment (lines 48-133, from `/**\n * Remap stale tariff
IDs...` through the closing `}` of the method).

- [ ] **Step 4: Inline the insert in `persistHistory`**

In `persistHistory`, replace the remap + insert block (lines 169-187):

```ts
        // Remap stale tariff IDs before inserting to handle concurrent tariff refresh
        const remappedRows = await this.remapTariffIds(siteId, filteredRows, site.tariffs);

        console.log(
            `[Importer] Remapped ${filteredRows.length - remappedRows.length} rows with stale tariff IDs`
        );

        await this.repo.insertEnergyDataBatch(remappedRows.map(row => ({
            site_id: row.site_id,
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id ?? null,
            timestamp: row.timestamp,
            load_power: row.load_power,
            solar_power: row.solar_power,
            grid_power: row.grid_power,
            battery_power: row.battery_power,
            battery_soc: row.battery_soc,
        })));
        console.log(`[Importer] Background persistence complete for site ${siteId}`);
```

with:

```ts
        await this.repo.insertEnergyDataBatch(filteredRows.map(row => ({
            site_id: row.site_id,
            tariff_id: row.tariff_id,
            tariff_schedule_id: row.tariff_schedule_id ?? null,
            timestamp: row.timestamp,
            load_power: row.load_power,
            solar_power: row.solar_power,
            grid_power: row.grid_power,
            battery_power: row.battery_power,
            battery_soc: row.battery_soc,
        })));
        console.log(`[Importer] Background persistence complete for site ${siteId}`);
```

- [ ] **Step 5: Inline the insert in `loadInterval`**

In `loadInterval`, replace the remap + insert block (lines 488-505):

```ts
            // Remap stale tariff IDs before inserting to handle concurrent tariff refresh
            const remappedRows = await this.remapTariffIds(site.id, filteredDatas, site.tariffs);

            console.log(
                `[Import] Remapped ${filteredDatas.length - remappedRows.length} rows with stale tariff IDs`
            );

            await this.repo.insertEnergyDataBatch(remappedRows.map(row => ({
                site_id: row.site_id,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                timestamp: row.timestamp,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
                battery_soc: row.battery_soc,
            })));
            return energyDatas;
```

with:

```ts
            await this.repo.insertEnergyDataBatch(filteredDatas.map(row => ({
                site_id: row.site_id,
                tariff_id: row.tariff_id,
                tariff_schedule_id: row.tariff_schedule_id,
                timestamp: row.timestamp,
                load_power: row.load_power,
                solar_power: row.solar_power,
                grid_power: row.grid_power,
                battery_power: row.battery_power,
                battery_soc: row.battery_soc,
            })));
            return energyDatas;
```

- [ ] **Step 6: Run the importer + repo tests**

Run: `npm test -- src/lib/importer src/lib/tariff-repo`
Expected: PASS — no references to `remapTariffIds`; `addTariffVersion` is used.

- [ ] **Step 7: Typecheck for stragglers**

Run: `npx tsc --noEmit`
Expected: no errors. (Catches any leftover `replaceTariffsForSite`/`remapTariffIds` reference.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/importer/index.ts src/lib/importer.test.ts
git commit -m "refactor(importer): remove tariff-ID remap (obsolete under versioning)"
```

---

## Task 8: TODO cleanup and full verification

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Remove resolved TODO items**

In `TODO.md` (repo root), delete the section
`## Discuss: harden tariff ID remap race window in importer` (item #4 — now fixed
by this work) and the section
`## TRMNL chart hour labels should use site timezone, not server timezone`
(item #5 — already shipped in PR #61).

- [ ] **Step 2: Full lint**

Run (from `cmd/next-app`): `npm run lint`
Expected: PASS (no errors).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS (all suites green).

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ../../TODO.md
git commit -m "docs: drop resolved tariff-remap and trmnl-timezone TODO items"
```

(Adjust the path to `TODO.md` to be repo-root relative from your shell.)

---

## Notes for the implementer

- **`ensureSite`'s JSON gate stays the primary filter.** It only calls
  `addTariffVersion` when Tesla's `tariff_content_v2` differs from what's stored
  (`importer/index.ts:363-404`). `addTariffVersion`'s `content_hash` check is the
  secondary guard against a JSON change the parser ignores. Existing `Tariff` rows
  have `content_hash = NULL`; the first genuine content change after deploy
  populates it. This does not create spurious versions on unchanged syncs (the
  JSON gate prevents the call entirely).
- **Concurrency** is bounded by the new unique indexes: two simultaneous
  `addTariffVersion` calls for one site can't both create the same `version`
  (`tariff_site_name_version_uidx`) or two current rows (`tariff_current_uidx`);
  the loser errors and the next sync retries. Duplicate-content concurrent calls
  are caught by the `content_hash` no-op.
- **Cascade FK retained by design.** `EnergyData.tariff_id` stays
  `ON DELETE CASCADE`. Harmless while nothing deletes tariffs; flagged in the spec
  Risks as optional future hardening (`ON DELETE RESTRICT`).
- **Out of scope** (per spec): version-aware/temporal pricing, old-version
  pruning, and any schedule-level natural key.
```
