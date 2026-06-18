# Install-Date Anchored Metered Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor every site's earliest metered `Tariff` version at `Site.installed` (the Tesla commissioning date) instead of `null`, so no metered version is ever undated — dissolving the two-null / ordering-trap problem class, retiring the standing warning, and giving the "Metered plan history" manager a one-date add-historic flow plus per-version edit.

**Architecture:** `Site.installed` (a `NOT NULL` column already persisted from Tesla `site_info.installation_date`) becomes the universal timeline floor. The importer stamps the first version with it; a backfill migration fills legacy null earliest versions; the metered manager adds historic plans by inserting a new floor-anchored version and bumping the previously-oldest version's date to the user-supplied switch date. Pricing is untouched — `pickByDate` already carries the earliest backward, so a concrete floor date is pricing-neutral.

**Tech Stack:** Next.js (App Router) route handlers, TypeScript, `pg` Pool, Vitest (pool-mocking + `renderToStaticMarkup`), SQL migration via `npm run db:migration:create`.

---

## SESSION STATE (read first)

**Branch:** `feat/roi`. Spec: [docs/superpowers/specs/2026-06-18-install-anchored-metered-timeline-design.md](../specs/2026-06-18-install-anchored-metered-timeline-design.md).

**The invariant this plan establishes and maintains:** within a site's metered (non-reporting) lineage, versions are **strictly date-ordered**, the **earliest version's `effective_from` equals `Site.installed`**, and **no metered `effective_from` is ever `null`**. Comparison plans (`reporting_only`) are out of scope and untouched.

## Key facts grounding this plan (verified against the code)

- **`Site.installed` is `NOT NULL`** ([db-migrations/20260123000001_init_schema.sql:20](../../cmd/next-app/db-migrations/20260123000001_init_schema.sql), later `TIMESTAMPTZ`), populated on every sync from `info.installation_date` at [importer/index.ts:327](../../cmd/next-app/src/lib/importer/index.ts). Dev-DB values are real 2020–2022 dates.
- **`addTariffVersion(siteId, parsed, detectionDate)`** currently sets `effective_from = version === 1 ? null : detectionDate` ([tariff-repo.ts:143](../../cmd/next-app/src/lib/tariff-repo.ts)). The importer calls it at [importer/index.ts:336](../../cmd/next-app/src/lib/importer/index.ts) with `localDateKey(new Date(), info.installation_time_zone)`.
- **`addHistoricMeteredVersion(siteId, parsed, effectiveFrom)`** ([tariff-repo.ts:199](../../cmd/next-app/src/lib/tariff-repo.ts)) currently inserts one non-current, non-reporting version dated to the raw `effectiveFrom`. This plan reworks it to insert at the install anchor **and** bump the previously-oldest version.
- **`pickByDate`** ([plan-timeline.ts:28](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) carries the earliest version backward (treats `null` as `0000-01-01`). Giving the earliest a concrete date is therefore pricing-neutral.
- **The metered route** ([metered-tariff/route.ts](../../cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts)) has PATCH (set date, with a two-null guard at lines 29-37) and POST (add historic, with a "set your current plan's start date first" guard at lines 57-59). Both guards are retired here.
- **Repo test harness** ([tariff-repo.test.ts:1-30](../../cmd/next-app/src/lib/tariff-repo.test.ts)): `vi.hoisted` exposes `connectMock`, `clientQueryMock`, `releaseMock`; `pool.query` is a plain `vi.fn()`; a `parsed: ParsedTariff` fixture and `sqlOf(call)` helper exist at module scope. Txn methods drive `clientQueryMock.mockImplementation(async (sql) => …)`.
- **Route test harness** ([metered-tariff/route.test.ts](../../cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts)): `vi.hoisted` mocks of `verifySiteAccess` and `TariffRepo`; a `req(body)` helper and `params = Promise.resolve({ id: 's1' })`.
- **Component test harness** ([MeteredTariffEditor.test.tsx](../../cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx)): `renderToStaticMarkup` + `vi.mock('next/navigation')` + `vi.mock('@/components/ui/Toast')`.
- **Tariff→ParsedSeason conversion** pattern exists at [comparison-tariff-repo.ts:171-196](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts) (a `bySeason` map). The comparison editor seeds via a `GET ?name=&version=` returning `{ seasons }` ([ComparisonTariffEditor.tsx:45](../../cmd/next-app/src/components/site/ComparisonTariffEditor.tsx)). We mirror this with a metered `GET ?version=`.
- **`coverageError(seasons)`** ([tou-coverage.ts:115](../../cmd/next-app/src/lib/roi/tou-coverage.ts)) validates full-day/week/year coverage.
- **`MeteredVersionSummary`** ([MeteredTariffEditor.tsx:12](../../cmd/next-app/src/components/site/MeteredTariffEditor.tsx)) already carries `version, effective_from, is_current, kind, buy_rate`. No new field is needed — the install-anchored date lives in `effective_from` after the migration.

---

## File Structure

**Modify:**
- `cmd/next-app/src/lib/tariff-repo.ts` — `addTariffVersion` install-date param; `getSiteInstalledDate`; rework `addHistoricMeteredVersion` to insert-and-bump; add `replaceMeteredVersion`; add `getMeteredVersionStructure`.
- `cmd/next-app/src/lib/tariff-repo.test.ts` — cover all of the above; fix existing 3-arg calls.
- `cmd/next-app/src/lib/importer/index.ts` — pass site-local install date to `addTariffVersion`.
- `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts` — GET (structure); PATCH (null→install, monotonic guard); POST (one-date add-historic); PUT (replace historic).
- `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts` — cover GET/PATCH/POST/PUT.
- `cmd/next-app/src/components/site/MeteredTariffEditor.tsx` — retire warning/guard; one-date add flow; per-version edit.
- `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx` — cover the new behavior.

**Create:**
- `cmd/next-app/db-migrations/<timestamp>_metered_install_anchor_backfill.sql` — backfill earliest null → `Site.installed::date`.

**Untouched (explicitly):** `plan-timeline.ts` (already date-resolves), `energy-repo.ts` (bill stays current-rate), comparison plans, `ScheduleEditor.tsx` (reused as-is).

---

## Task 1: Importer anchors the first metered version at the install date

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`, `cmd/next-app/src/lib/importer/index.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Find the existing `describe('TariffRepo.addTariffVersion — effective_from stamping', …)` block in `cmd/next-app/src/lib/tariff-repo.test.ts` and replace its two `it(...)` bodies so they pass the new 4th arg and assert the install-date anchor. Replace the whole describe block with:

```ts
describe('TariffRepo.addTariffVersion — effective_from stamping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    function mockSeq(nextVersion: number) {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT content_hash')) return { rows: [{ content_hash: 'STALE' }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: nextVersion }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 8 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 80 }] };
            return { rows: [] };
        });
    }
    function tariffInsertCall() {
        return clientQueryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "Tariff"'))!;
    }

    it('stamps the install date on the first version (carries backward as the floor)', async () => {
        mockSeq(1);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');
        const call = tariffInsertCall();
        expect(String(call[0])).toMatch(/effective_from/);
        expect(call[1]).toContain('2020-01-15');
        expect(call[1]).not.toContain('2026-06-18');
    });

    it('stamps the detection date on a non-first version', async () => {
        mockSeq(3);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');
        const call = tariffInsertCall();
        expect(call[1]).toContain('2026-06-18');
        expect(call[1]).not.toContain('2020-01-15');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — `addTariffVersion` takes 3 args / version 1 still inserts `null`.

- [ ] **Step 3: Implement the signature + anchor change**

In `cmd/next-app/src/lib/tariff-repo.ts`, change the `addTariffVersion` signature (line 109):

```ts
    async addTariffVersion(siteId: string, parsed: ParsedTariff, detectionDate: string, installDate: string): Promise<void> {
```

Replace the `effectiveFrom` line (line 143) and its comment (lines 141-142) with:

```ts
            // The first version anchors at the site's install date (the timeline floor — it
            // carries backward over all history). Later versions are dated to detection (the
            // honest upper bound for a Tesla-detected change; the user can correct it).
            const effectiveFrom = version === 1 ? installDate : detectionDate;
```

- [ ] **Step 4: Update the importer caller**

In `cmd/next-app/src/lib/importer/index.ts`, replace the block at lines 336-337:

```ts
                const detectionDate = localDateKey(new Date(), info.installation_time_zone);
                await this.tariffRepo.addTariffVersion(siteId, parsed, detectionDate);
```

with:

```ts
                const detectionDate = localDateKey(new Date(), info.installation_time_zone);
                const installDate = localDateKey(new Date(info.installation_date), info.installation_time_zone);
                await this.tariffRepo.addTariffVersion(siteId, parsed, detectionDate, installDate);
```

- [ ] **Step 5: Fix the other existing `addTariffVersion` tests**

The two tests in `describe('TariffRepo.addTariffVersion', …)` (the append/no-op tests near the top of the file) call `addTariffVersion('site-1', parsed, '2026-06-18')`. Add a 4th arg to both call sites:

```ts
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18', '2020-01-15');
```

- [ ] **Step 6: Run tests + types**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo && npx tsc --noEmit`
Expected: PASS; no type errors (importer now passes 4 args).

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts cmd/next-app/src/lib/importer/index.ts
git commit -m "feat(roi): anchor first metered version at the site install date"
```

---

## Task 2: Backfill migration — earliest null metered version → install date

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_metered_install_anchor_backfill.sql` (generated)

- [ ] **Step 1: Generate the migration file**

Run: `cd cmd/next-app && npm run db:migration:create metered_install_anchor_backfill`
Expected: prints the created path `db-migrations/<timestamp>_metered_install_anchor_backfill.sql`.

- [ ] **Step 2: Write the migration SQL**

Replace the generated file's contents with:

```sql
-- Anchor each site's earliest metered (non-reporting) Tariff version at the site's
-- commissioning date instead of NULL. The earliest version carries backward over all
-- history; Site.installed is the honest floor (no energy precedes it) and gives the row a
-- concrete date the UI/ordering guard can rely on. Later versions were already dated by the
-- prior detection-date backfill. Comparison plans (reporting_only) are never touched.
-- Idempotent: once set, the row is no longer NULL, so a re-run is a no-op.
UPDATE "Tariff" t
SET effective_from = s.installed::date
FROM "Site" s
WHERE t.site_id = s.id
  AND NOT t.reporting_only
  AND t.effective_from IS NULL
  AND t.version = (
    SELECT MIN(m.version) FROM "Tariff" m
    WHERE m.site_id = t.site_id AND NOT m.reporting_only
  );
```

- [ ] **Step 3: Sanity-check the SQL locally (optional, requires DB)**

If a local/dev Postgres is configured (`DATABASE_URL`), after applying migrations verify no metered version remains null:

```bash
cd cmd/next-app
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"Tariff\" WHERE NOT reporting_only AND effective_from IS NULL;"
```

Expected: `0`.

> Migrations are not unit-tested in this repo; CI applies them against a prod backup on PR (per CLAUDE.md). Keep the SQL idempotent.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/*_metered_install_anchor_backfill.sql
git commit -m "feat(roi): backfill earliest metered version to the install date"
```

---

## Task 3: Repo — install-date lookup + insert-and-bump add-historic

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('TariffRepo.addHistoricMeteredVersion', …)` block in `cmd/next-app/src/lib/tariff-repo.test.ts` with the following, and add a `getSiteInstalledDate` describe alongside it:

```ts
describe('TariffRepo.getSiteInstalledDate', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('returns the site install date as YYYY-MM-DD', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [{ installed: '2020-01-15' }] });
        const d = await new TariffRepo().getSiteInstalledDate('site-1');
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/installed::date/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1']);
        expect(d).toBe('2020-01-15');
    });
});

describe('TariffRepo.addHistoricMeteredVersion — insert at install + bump previous oldest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });

    it('inserts a non-current metered version dated to install and bumps the previous oldest to the switch date', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('installed::date')) return { rows: [{ installed: '2020-01-15' }] };
            if (sql.includes('SELECT name')) return { rows: [{ name: 'PG&E' }] };
            // previous-oldest lookup: the version currently at the minimum effective_from
            if (sql.includes('ORDER BY effective_from ASC')) return { rows: [{ version: 1 }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: 4 }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 9 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 90 }] };
            return { rows: [] };
        });

        await new TariffRepo().addHistoricMeteredVersion('site-1', parsed, '2025-09-01');

        const calls = clientQueryMock.mock.calls;
        const sqls = calls.map(sqlOf);
        // new version inserted at the install anchor, not current, not reporting-only
        const insert = calls.find(c => String(c[0]).includes('INSERT INTO "Tariff"'))!;
        expect(String(insert[0])).toMatch(/reporting_only/);
        expect(String(insert[0])).toMatch(/false,\s*false/);
        expect(insert[1]).toEqual(expect.arrayContaining(['site-1', 'PG&E', 4, '2020-01-15']));
        // previous oldest (version 1) bumped to the switch date
        const bump = calls.find(c => String(c[0]).includes('UPDATE "Tariff" SET effective_from'))!;
        expect(bump[1]).toEqual(['site-1', 1, '2025-09-01']);
        expect(sqls.some(s => s.includes('COMMIT'))).toBe(true);
        // never demotes the Tesla current version
        expect(sqls.some(s => s.includes('is_current = false'))).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — `getSiteInstalledDate` undefined; `addHistoricMeteredVersion` takes a raw date and does not bump.

- [ ] **Step 3: Implement `getSiteInstalledDate`**

In `cmd/next-app/src/lib/tariff-repo.ts`, add to `TariffRepo` (after `listMeteredVersions`, before `// === Commands ===`):

```ts
    /** The site's commissioning date as 'YYYY-MM-DD' — the metered timeline floor. */
    async getSiteInstalledDate(siteId: string): Promise<string> {
        const res = await pool.query('SELECT installed::date::text AS installed FROM "Site" WHERE id = $1', [siteId]);
        return res.rows[0]?.installed as string;
    }
```

- [ ] **Step 4: Rewrite `addHistoricMeteredVersion` to insert-and-bump**

In `cmd/next-app/src/lib/tariff-repo.ts`, replace the entire `addHistoricMeteredVersion` method (lines 195-254) with:

```ts
    /** Add a user-authored historic metered version: a plan that ran before the current one.
     *  The new version becomes the timeline floor (effective_from = Site.installed, NOT current,
     *  reporting_only = false so the metered timeline includes it), and the previously-oldest
     *  version is bumped to `switchDate` (when the user moved off the new plan onto it). The
     *  Tesla current version is never demoted. Atomic. */
    async addHistoricMeteredVersion(siteId: string, parsed: ParsedTariff, switchDate: string): Promise<void> {
        const newHash = tariffContentHash(parsed);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const installedRes = await client.query('SELECT installed::date::text AS installed FROM "Site" WHERE id = $1', [siteId]);
            const installDate = installedRes.rows[0]?.installed as string;

            // Name the historic version after the current metered plan (same plan, earlier in time).
            const nameRes = await client.query(
                `SELECT name FROM "Tariff" WHERE site_id = $1 AND is_current AND NOT reporting_only LIMIT 1`,
                [siteId],
            );
            const planName = (nameRes.rows[0]?.name as string | undefined) ?? parsed.name;

            // The version currently at the floor; it gets bumped to the switch date.
            const oldestRes = await client.query(
                `SELECT version FROM "Tariff" WHERE site_id = $1 AND NOT reporting_only ORDER BY effective_from ASC, version ASC LIMIT 1`,
                [siteId],
            );
            const previousOldest = oldestRes.rows[0]?.version as number | undefined;

            const verRes = await client.query(
                'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
                [siteId],
            );
            const version = verRes.rows[0].next;

            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, content_hash, effective_from, updated)
                 VALUES ($1, $2, $3, false, false, $4, $5, NOW())
                 RETURNING id`,
                [siteId, planName, version, newHash, installDate],
            );
            const tariffId = tariffRes.rows[0].id;

            for (const season of parsed.seasons) {
                const seasonRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate],
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
                        ],
                    );
                }
            }

            // Bump the previously-oldest version off the floor to the user-supplied switch date.
            if (previousOldest != null) {
                await client.query(
                    `UPDATE "Tariff" SET effective_from = $3, updated = NOW()
                      WHERE site_id = $1 AND version = $2 AND NOT reporting_only`,
                    [siteId, previousOldest, switchDate],
                );
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts
git commit -m "feat(roi): add-historic inserts at install floor and bumps previous oldest"
```

---

## Task 4: Repo — edit a metered version (replace structure) + read its structure

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cmd/next-app/src/lib/tariff-repo.test.ts`:

```ts
describe('TariffRepo.getMeteredVersionStructure', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('returns the version name + parsed seasons (no ids)', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [
            { tariff_name: 'PG&E', season_id: 90, season_name: 'All Year',
              from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.2, season_sell_rate: 0.05, schedule_id: 900, schedule_name: 'W',
              schedule_buy_rate: 0.2, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
        ] });
        const out = await new TariffRepo().getMeteredVersionStructure('site-1', 2);
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/NOT t\.reporting_only/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 2]);
        expect(out).not.toBeNull();
        expect(out!.name).toBe('PG&E');
        expect(out!.seasons[0].schedules[0].buy_rate).toBe(0.2);
        expect('id' in out!.seasons[0]).toBe(false);
    });
});

describe('TariffRepo.replaceMeteredVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });
    it('rejects replacing the Tesla current version (rates are read-only)', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT id, is_current')) return { rows: [{ id: 7, is_current: true }] };
            return { rows: [] };
        });
        await expect(new TariffRepo().replaceMeteredVersion('site-1', 2, parsed, '2025-09-01'))
            .rejects.toThrow(/current/i);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('ROLLBACK'))).toBe(true);
    });
    it('replaces a historic version: deletes old seasons, reinserts, updates date', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT id, is_current')) return { rows: [{ id: 9, is_current: false }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 91 }] };
            return { rows: [] };
        });
        await new TariffRepo().replaceMeteredVersion('site-1', 4, parsed, '2025-09-01');
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('DELETE FROM "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('INSERT INTO "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('UPDATE "Tariff" SET name'))).toBe(true);
        expect(sqls.some(s => s.includes('COMMIT'))).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement `getMeteredVersionStructure`**

In `cmd/next-app/src/lib/tariff-repo.ts`, add this import-type to line 2 (it already imports from `./importer/tariff-parser`):

```ts
import { ParsedTariff, ParsedSeason, tariffContentHash } from './importer/tariff-parser';
```

Add to `TariffRepo` (after `getSiteInstalledDate`):

```ts
    /** One metered version's structure as a parsed (id-free) tariff, for seeding the editor.
     *  Guarded to non-reporting. Returns null when the version is absent. */
    async getMeteredVersionStructure(siteId: string, version: number): Promise<{ name: string; seasons: ParsedSeason[] } | null> {
        const res = await pool.query(
            `SELECT t.name AS tariff_name,
                    se.id AS season_id, se.name AS season_name,
                    se.from_month, se.from_day, se.to_month, se.to_day,
                    se.buy_rate AS season_buy_rate, se.sell_rate AS season_sell_rate,
                    sc.id AS schedule_id, sc.name AS schedule_name,
                    sc.buy_rate AS schedule_buy_rate, sc.sell_rate AS schedule_sell_rate,
                    sc.from_day_of_week, sc.from_hour, sc.from_minute,
                    sc.to_day_of_week, sc.to_hour, sc.to_minute
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
               LEFT JOIN "TariffSchedule" sc ON sc.season_id = se.id
              WHERE t.site_id = $1 AND t.version = $2 AND NOT t.reporting_only
              ORDER BY se.id, sc.id`,
            [siteId, version],
        );
        if (res.rows.length === 0) return null;
        const bySeason = new Map<number, ParsedSeason>();
        for (const r of res.rows) {
            const sid = Number(r.season_id);
            if (!bySeason.has(sid)) {
                bySeason.set(sid, {
                    name: r.season_name ?? '',
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate),
                    schedules: [],
                });
            }
            if (r.schedule_id != null) {
                bySeason.get(sid)!.schedules.push({
                    name: r.schedule_name ?? '',
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : Number(r.season_buy_rate),
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : Number(r.season_sell_rate),
                    from_day_of_week: Number(r.from_day_of_week), to_day_of_week: Number(r.to_day_of_week),
                    from_hour: Number(r.from_hour), from_minute: Number(r.from_minute),
                    to_hour: Number(r.to_hour), to_minute: Number(r.to_minute),
                });
            }
        }
        return { name: res.rows[0].tariff_name as string, seasons: Array.from(bySeason.values()) };
    }
```

- [ ] **Step 4: Implement `replaceMeteredVersion`**

Add to `TariffRepo` (after `addHistoricMeteredVersion`):

```ts
    /** Replace a user-authored historic metered version's structure (seasons/schedules) and
     *  effective date in place. Rejects the Tesla current version — its rates are Tesla's and
     *  stay read-only (use setMeteredEffectiveFrom for a date-only change). Atomic. */
    async replaceMeteredVersion(siteId: string, version: number, parsed: ParsedTariff, effectiveFrom: string): Promise<void> {
        const newHash = tariffContentHash(parsed);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const tRes = await client.query(
                'SELECT id, is_current FROM "Tariff" WHERE site_id = $1 AND version = $2 AND NOT reporting_only',
                [siteId, version],
            );
            const row = tRes.rows[0] as { id: number; is_current: boolean } | undefined;
            if (!row) throw new Error('Version not found.');
            if (row.is_current) throw new Error("Your current plan's rates come from Tesla and can't be edited.");
            const tariffId = row.id;

            // Replace children: deleting seasons cascades to their schedules.
            await client.query('DELETE FROM "TariffSeason" WHERE tariff_id = $1', [tariffId]);
            await client.query(
                'UPDATE "Tariff" SET name = $3, content_hash = $4, effective_from = $5, updated = NOW() WHERE site_id = $1 AND version = $2',
                [siteId, version, parsed.name, newHash, effectiveFrom],
            );

            for (const season of parsed.seasons) {
                const seasonRes = await client.query(
                    `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate],
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
                        ],
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
```

> Note: deleting a `TariffSeason` row must cascade to its `TariffSchedule` children. The schema defines `TariffSchedule.season_id` with `ON DELETE CASCADE` (verify: `grep -n "season_id" cmd/next-app/db-migrations/20260123000001_init_schema.sql`). If it does not cascade, add `await client.query('DELETE FROM "TariffSchedule" WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)', [tariffId]);` before the season delete.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts
git commit -m "feat(roi): read + replace metered version structure (historic edit)"
```

---

## Task 5: Route — GET structure, monotonic PATCH, one-date POST, edit PUT

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts`
- Test: `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts`

- [ ] **Step 1: Rewrite the route test**

Replace the entire contents of `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyMock, setDateMock, addHistoricMock, replaceMock, listMock, installedMock, structMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), setDateMock: vi.fn(), addHistoricMock: vi.fn(), replaceMock: vi.fn(),
    listMock: vi.fn(), installedMock: vi.fn(), structMock: vi.fn(),
}));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/tariff-repo', () => ({
    TariffRepo: vi.fn(() => ({
        setMeteredEffectiveFrom: setDateMock,
        addHistoricMeteredVersion: addHistoricMock,
        replaceMeteredVersion: replaceMock,
        listMeteredVersions: listMock,
        getSiteInstalledDate: installedMock,
        getMeteredVersionStructure: structMock,
    })),
}));

import { GET, PATCH, POST, PUT } from './route';

function req(body: unknown, url = 'http://test/api/site/s1/metered-tariff') {
    return new Request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}
function getReq(url: string) {
    return new Request(url) as unknown as import('next/server').NextRequest;
}
const params = Promise.resolve({ id: 's1' });
const fullYearSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.05,
    schedules: [{ name: 'W', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];

beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockResolvedValue(true);
    installedMock.mockResolvedValue('2020-01-15');
    // default lineage: a single current version anchored at install
    listMock.mockResolvedValue([{ version: 1, effective_from: '2020-01-15', is_current: true }]);
});

describe('metered-tariff GET (version structure)', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=2'), { params });
        expect(res.status).toBe(403);
    });
    it('returns the parsed structure for a version', async () => {
        structMock.mockResolvedValue({ name: 'PG&E', seasons: fullYearSeasons });
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=2'), { params });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: 'PG&E', seasons: fullYearSeasons });
        expect(structMock).toHaveBeenCalledWith('s1', 2);
    });
    it('404 when the version is absent', async () => {
        structMock.mockResolvedValue(null);
        const res = await GET(getReq('http://test/api/site/s1/metered-tariff?version=9'), { params });
        expect(res.status).toBe(404);
    });
});

describe('metered-tariff PATCH (date-only)', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await PATCH(req({ version: 1, effective_from: '2021-01-01' }), { params });
        expect(res.status).toBe(403);
    });
    it('400 when version missing', async () => {
        const res = await PATCH(req({ effective_from: '2021-01-01' }), { params });
        expect(res.status).toBe(400);
    });
    it('clearing the date snaps the earliest back to the install date (never null)', async () => {
        const res = await PATCH(req({ version: 1, effective_from: null }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 1, '2020-01-15');
    });
    it('sets a date and keeps the lineage ordered', async () => {
        listMock.mockResolvedValue([
            { version: 1, effective_from: '2020-01-15', is_current: false },
            { version: 2, effective_from: '2025-01-01', is_current: true },
        ]);
        const res = await PATCH(req({ version: 2, effective_from: '2024-06-01' }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 2, '2024-06-01');
    });
    it('400 on a non-monotonic date (would overtake a later version)', async () => {
        listMock.mockResolvedValue([
            { version: 1, effective_from: '2020-01-15', is_current: false },
            { version: 2, effective_from: '2025-01-01', is_current: true },
        ]);
        const res = await PATCH(req({ version: 1, effective_from: '2026-01-01' }), { params });
        expect(res.status).toBe(400);
        expect(setDateMock).not.toHaveBeenCalled();
    });
});

describe('metered-tariff POST (add historic, one date)', () => {
    it('400 on a coverage gap', async () => {
        const res = await POST(req({ switch_date: '2024-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('400 when switch_date missing', async () => {
        const res = await POST(req({ seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
    });
    it('400 when switch_date is not after the install date', async () => {
        const res = await POST(req({ switch_date: '2019-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('creates a historic version with the switch date', async () => {
        const res = await POST(req({ switch_date: '2024-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(addHistoricMock).toHaveBeenCalledWith('s1', expect.objectContaining({ seasons: fullYearSeasons }), '2024-01-01');
    });
});

describe('metered-tariff PUT (edit historic)', () => {
    it('400 on a coverage gap', async () => {
        const res = await PUT(req({ version: 4, effective_from: '2024-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(replaceMock).not.toHaveBeenCalled();
    });
    it('replaces a historic version structure + date', async () => {
        listMock.mockResolvedValue([
            { version: 4, effective_from: '2020-01-15', is_current: false },
            { version: 1, effective_from: '2024-01-01', is_current: true },
        ]);
        const res = await PUT(req({ version: 4, effective_from: '2020-01-15', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(replaceMock).toHaveBeenCalledWith('s1', 4, expect.objectContaining({ seasons: fullYearSeasons }), '2020-01-15');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/app/api/site/\\[id\\]/metered-tariff`
Expected: FAIL — `./route` has no `GET`/`PUT`; POST expects `effective_from`, not `switch_date`.

- [ ] **Step 3: Rewrite the route**

Replace the entire contents of `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TariffRepo } from '@/lib/tariff-repo';
import { coverageError } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

// listMeteredVersions returns no is_current; the route only needs version + date for ordering.
// (The Tesla-current rate-edit rejection lives in repo.replaceMeteredVersion, not here.)
type Lite = { version: number; effective_from: string | null };

/** Strict-order check: would setting `version` to `date` keep every earlier version's date
 *  below it and every later version's date above it? Compares against the current ordering. */
function ordered(versions: Lite[], version: number, date: string): boolean {
    const others = versions.filter(v => v.version !== version).map(v => v.effective_from).filter((d): d is string => d != null);
    const target = versions.find(v => v.version === version);
    if (!target) return false;
    const earlierMax = versions.filter(v => v.version !== version && v.effective_from != null && v.effective_from < (target.effective_from ?? ''))
        .map(v => v.effective_from as string);
    const laterMin = versions.filter(v => v.version !== version && v.effective_from != null && v.effective_from > (target.effective_from ?? ''))
        .map(v => v.effective_from as string);
    if (others.includes(date)) return false; // distinct dates
    if (earlierMax.some(d => date <= d)) return false;
    if (laterMin.some(d => date >= d)) return false;
    return true;
}

/** GET ?version=N — one metered version's parsed structure, for seeding the editor. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const version = Number(new URL(request.url).searchParams.get('version'));
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const structure = await new TariffRepo().getMeteredVersionStructure(id, version);
    if (!structure) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    return NextResponse.json(structure);
}

/** PATCH — date-only edit of one metered version. Clearing snaps the earliest to the install
 *  floor (never null). Rejects a non-monotonic date. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const version = Number(body.version);
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const repo = new TariffRepo();
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    if (!versions.some(v => v.version === version)) {
        return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }
    // No nulls allowed: clearing snaps to the install floor.
    const effectiveFrom = body.effective_from ? String(body.effective_from) : await repo.getSiteInstalledDate(id);
    if (!ordered(versions, version, effectiveFrom)) {
        return NextResponse.json({ error: 'That date would put your plan versions out of order.' }, { status: 400 });
    }
    await repo.setMeteredEffectiveFrom(id, version, effectiveFrom);
    return NextResponse.json({ success: true });
}

/** POST — add a historic plan with ONE date (the switch date onto the next-newer plan). The new
 *  plan anchors at the install floor; the previously-oldest version is bumped to switch_date. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const switchDate = body.switch_date ? String(body.switch_date) : null;
    if (!switchDate) {
        return NextResponse.json({ error: 'A historic plan needs the date you switched onto your next plan.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new TariffRepo();
    const installed = await repo.getSiteInstalledDate(id);
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    // switch_date must be after the install floor and before the next boundary (the successor of
    // the previously-oldest version, i.e. the second-oldest current date, or "now" if none).
    const dated = versions.map(v => v.effective_from).filter((d): d is string => d != null).sort();
    const nextBoundary = dated[1] ?? new Date().toISOString().slice(0, 10);
    if (switchDate <= installed || switchDate >= nextBoundary) {
        return NextResponse.json({ error: 'The switch date must be after your install date and before your next plan change.' }, { status: 400 });
    }
    await repo.addHistoricMeteredVersion(id, { name: '', seasons }, switchDate);
    return NextResponse.json({ success: true });
}

/** PUT — edit a user-authored historic version's rates + date. The repo rejects the Tesla
 *  current version (rates read-only). Rejects coverage gaps and non-monotonic dates. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const version = Number(body.version);
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    if (!effectiveFrom) {
        return NextResponse.json({ error: 'An effective date is required.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new TariffRepo();
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    if (versions.some(v => v.version === version) && !ordered(versions, version, effectiveFrom)) {
        return NextResponse.json({ error: 'That date would put your plan versions out of order.' }, { status: 400 });
    }
    await repo.replaceMeteredVersion(id, version, { name: '', seasons }, effectiveFrom);
    return NextResponse.json({ success: true });
}
```

> The repo's `replaceMeteredVersion` throws on the Tesla current version; the catch isn't shown here because the component never offers a rate-edit on the current version (PATCH is used for its date). A thrown error surfaces as a 500, which is acceptable for this guarded-by-UI path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/app/api/site/\\[id\\]/metered-tariff`
Expected: PASS.

- [ ] **Step 5: Run lint + types**

Run: `cd cmd/next-app && npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/api/site/\[id\]/metered-tariff/
git commit -m "feat(roi): metered route — GET structure, monotonic PATCH, one-date POST, edit PUT"
```

---

## Task 6: Component — retire warning, install-anchored display, one-date add, per-version edit

**Files:**
- Modify: `cmd/next-app/src/components/site/MeteredTariffEditor.tsx`
- Test: `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx`

- [ ] **Step 1: Rewrite the component test**

Replace the entire contents of `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx` with:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeteredTariffEditor, type MeteredVersionSummary } from './MeteredTariffEditor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const versions: MeteredVersionSummary[] = [
    { version: 2, effective_from: '2025-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
    { version: 1, effective_from: '2020-01-15', is_current: false, kind: 'fixed', buy_rate: 0.16 },
];

describe('MeteredTariffEditor', () => {
    it('lists versions with their concrete effective dates, no undated/warning state', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toContain('2025-01-01');
        expect(html).toContain('2020-01-15');
        expect(html).toContain('current');
        // the retired guard copy must be gone
        expect(html).not.toMatch(/from the beginning/i);
        expect(html).not.toMatch(/set your current plan/i);
        expect(html).toContain('TOU');
        expect(html).toContain('0.16');
    });

    it('offers an "add historic plan" action (never disabled — no null state)', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toMatch(/add historic plan/i);
        expect(html).not.toContain('⚠️');
    });

    it('offers edit on each version', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toMatch(/edit/i);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/MeteredTariffEditor`
Expected: FAIL — current component still renders "from the beginning" / warning and has no Edit affordance.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `cmd/next-app/src/components/site/MeteredTariffEditor.tsx` with:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { ScheduleEditor, type SchedulePayload } from '@/components/site/ScheduleEditor';
import { buildFixedComparisonInput } from '@/lib/roi/fixed-comparison';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export interface MeteredVersionSummary {
    version: number;
    effective_from: string | null;
    is_current: boolean;
    kind: 'fixed' | 'tou';
    buy_rate: number;
}

const blankSeed = (): ParsedSeason[] => buildFixedComparisonInput({ name: '', buyRate: 0, sellRate: 0 }).seasons;

type EditState = { version: number; seasons: ParsedSeason[]; effectiveFrom: string };

export function MeteredTariffEditor({ siteId, versions }: { siteId: string; versions: MeteredVersionSummary[] }) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/metered-tariff`;

    const [busy, setBusy] = useState(false);
    const [editingDate, setEditingDate] = useState<number | null>(null); // Tesla-current date edit
    const [dateValue, setDateValue] = useState('');
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<EditState | null>(null); // historic rate+date edit

    const earliestVersion = versions.reduce((min, v) => Math.min(min, v.version), Infinity);

    async function send(method: string, body: unknown, okMsg: string): Promise<boolean> {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status >= 400) { const j = await res.json(); throw new Error(j.error || 'request failed'); }
            toast({ title: 'Saved', description: okMsg, variant: 'success' });
            router.refresh();
            return true;
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
            return false;
        } finally { setBusy(false); }
    }

    async function saveDate(version: number) {
        const ok = await send('PATCH', { version, effective_from: dateValue || null }, 'Effective date updated.');
        if (ok) { setEditingDate(null); setDateValue(''); }
    }

    async function onSaveHistoric(payload: SchedulePayload): Promise<boolean> {
        const ok = await send('POST', { switch_date: payload.effectiveFrom || null, seasons: payload.seasons }, 'Historic plan added.');
        if (ok) setAdding(false);
        return ok;
    }

    async function openEdit(version: number, effectiveFrom: string | null) {
        setBusy(true);
        try {
            const res = await fetch(`${base}?version=${version}`);
            if (!res.ok) throw new Error('Could not load that version.');
            const j = await res.json() as { seasons: ParsedSeason[] };
            setEditing({ version, seasons: j.seasons, effectiveFrom: effectiveFrom ?? '' });
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not load.', variant: 'danger' });
        } finally { setBusy(false); }
    }

    async function onSaveEdit(payload: SchedulePayload): Promise<boolean> {
        if (!editing) return false;
        const ok = await send('PUT', { version: editing.version, effective_from: payload.effectiveFrom || null, seasons: payload.seasons }, 'Plan updated.');
        if (ok) setEditing(null);
        return ok;
    }

    if (adding) {
        return (
            <Card>
                <CardHeader><CardTitle>Add a historic plan</CardTitle>
                    <CardDescription>Enter a metered plan that ran before your current one. The date you set is when you switched <em>off</em> it onto your next plan — it anchors at your install date and prices the history before the switch.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScheduleEditor
                        name="Your plan"
                        nameLocked
                        effectiveFrom=""
                        initialSeasons={blankSeed()}
                        cloneSources={[]}
                        onClone={async () => []}
                        onSave={onSaveHistoric}
                        onCancel={() => setAdding(false)}
                    />
                </CardContent>
            </Card>
        );
    }

    if (editing) {
        return (
            <Card>
                <CardHeader><CardTitle>Edit historic plan</CardTitle>
                    <CardDescription>Adjust this past plan&apos;s rates and the date it took effect.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScheduleEditor
                        name="Your plan"
                        nameLocked
                        effectiveFrom={editing.effectiveFrom}
                        initialSeasons={editing.seasons}
                        cloneSources={[]}
                        onClone={async () => []}
                        onSave={onSaveEdit}
                        onCancel={() => setEditing(null)}
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader><CardTitle>Metered plan history</CardTitle>
                <CardDescription>Your real plan over time, anchored at your install date. Rates for your current plan come from Tesla; set when each version took effect so your savings price each period correctly.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {versions.map(v => (
                    <div key={v.version} className="flex items-center gap-3 text-sm rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        {v.kind === 'tou'
                            ? <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-xs font-medium">TOU</span>
                            : <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>}
                        {editingDate === v.version ? (
                            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); saveDate(v.version); }}>
                                <Input type="date" className="max-w-44" value={dateValue} onChange={(e) => setDateValue(e.target.value)} />
                                <Button type="submit" size="sm" disabled={busy}>Save</Button>
                                <button type="button" tabIndex={0} onClick={() => setEditingDate(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                            </form>
                        ) : (
                            <>
                                <span className="text-gray-500 dark:text-gray-400">
                                    {v.version === earliestVersion ? `since ${v.effective_from}` : v.effective_from}
                                    {v.is_current ? ' · current' : ''}
                                </span>
                                {v.is_current ? (
                                    <button type="button" tabIndex={0} disabled={busy}
                                        onClick={() => { setEditingDate(v.version); setDateValue(v.effective_from ?? ''); }}
                                        className="ml-auto text-xs text-primary hover:underline rounded px-1">Set date</button>
                                ) : (
                                    <button type="button" tabIndex={0} disabled={busy}
                                        onClick={() => openEdit(v.version, v.effective_from)}
                                        className="ml-auto text-xs text-primary hover:underline rounded px-1">Edit</button>
                                )}
                            </>
                        )}
                    </div>
                ))}
                <Button type="button" onClick={() => setAdding(true)} disabled={busy}>Add historic plan</Button>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/MeteredTariffEditor`
Expected: PASS.

- [ ] **Step 5: Verify types + lint**

Run: `cd cmd/next-app && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/components/site/MeteredTariffEditor.tsx cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx
git commit -m "feat(roi): metered manager — install-anchored display, one-date add, per-version edit"
```

---

## Task 7: Final verification

- [ ] **Step 1:** `cd cmd/next-app && npm test` — all pass.
- [ ] **Step 2:** `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit` — all pass.
- [ ] **Step 3: Confirm no metered null path remains in the UI guard.** `cd cmd/next-app && grep -rn "from the beginning\|hasUndated\|set your current plan" src/components/site/MeteredTariffEditor.tsx src/app/api/site/\[id\]/metered-tariff/route.ts` → expected: no matches.
- [ ] **Step 4: Confirm the install anchor is the first-version stamp.** `cd cmd/next-app && grep -n "version === 1 ? installDate" src/lib/tariff-repo.ts` → expected: one match.
- [ ] **Step 5 (optional, live):** on a single-version site, open Savings → Savings settings → "Metered plan history": confirm no warning, the version reads "since <install date>", and **Add historic plan** is enabled. Add a historic plan with a switch date inside your data window; confirm the metered grid column / payback hero re-price history before the switch at the historic rate, and that editing the historic plan's rates re-prices accordingly.
- [ ] **Step 6:** `git push origin feat/roi` (only when the user asks).

---

## Self-review notes (for the implementer)

- **Every commit builds.** Task 1 changes the stamp + caller together. Task 2 is a standalone migration. Tasks 3–4 add repo methods (old `addHistoricMeteredVersion` callers are the route, updated in Task 5). Task 5 rewires the route to the new repo surface. Task 6 rewires the component to the new route surface. Task 7 verifies.
- **Ordering of Tasks 3→5 matters:** the route (Task 5) calls `getSiteInstalledDate`, the reworked `addHistoricMeteredVersion`, `replaceMeteredVersion`, and `getMeteredVersionStructure` — all added in Tasks 3–4. Do not run Task 5 before 3–4.
- **The invariant** (no null, earliest = install, strictly ordered) is established by Task 1 (new sites) + Task 2 (existing) and maintained by the route's `ordered()` check (PATCH/PUT) and the POST bounds check.
- **Pricing is unchanged** — `pickByDate` carries the earliest backward whether it is null or the install date, so single-version sites price identically (Task 7 Step 5 spot-checks this).
- **Tesla content stays Tesla's** — the current version is rate-read-only (`replaceMeteredVersion` rejects it; the component offers only "Set date" on it). Historic versions are fully user-authored and editable.
- **No delete** this iteration (per spec) — a mistaken historic entry is corrected via Edit.
