# Metered Plan History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give metered `Tariff` versions correct `effective_from` dates and feed *all* metered versions into the ROI/savings timeline, so a site whose rate plan changed over time prices each period at the version that was actually in effect — and let the user correct those dates and author historic versions.

**Architecture:** Four moving parts. (1) A new `listMeteredVersions` loader + `page.tsx` swap so `meteredTimeline` receives every metered version, not just the current one. (2) The importer stamps `effective_from` (detection date) on each newly-detected version. (3) An idempotent migration backfills existing null-dated versions. (4) A dedicated "Metered plan history" manager (new route + repo writes + component) for editing dates and adding historic versions, reusing the route-agnostic `ScheduleEditor`.

**Tech Stack:** Next.js (App Router) Server Component (`page.tsx`), TypeScript, `pg` Pool, Vitest (pool-mocking style), SQL migration via `npm run db:migration:create`.

---

## SESSION STATE (read first)

**Branch:** `feat/roi`. Spec: [docs/superpowers/specs/2026-06-18-metered-plan-history-design.md](../specs/2026-06-18-metered-plan-history-design.md).

**Pre-existing semantics (unchanged):** ROI/savings prices the metered plan via `meteredTimeline(tariffs, tz)` ([plan-timeline.ts:62](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) → `scheduleTimeline` → `pickByDate`, which carries the *earliest* version backward and resolves later dates by `effective_from`. The bill view (`energy-repo`) prices with the *current* tariff only and is **out of scope** here.

**The invariant this plan establishes and maintains:** within the metered plan, **at most one version may have a null `effective_from`, and it must be the chronologically earliest** (it carries backward; no energy precedes the first version).

## Key facts grounding this plan (verified against the code)

- **The metered timeline is currently fed only the *current* version.** The site query joins tariffs with `t.is_current AND NOT t.reporting_only` ([site-repo.ts:73](../../cmd/next-app/src/lib/site-repo.ts)), so `finalSite.tariffs` holds a single metered version. `page.tsx` calls `meteredTimeline(finalSite.tariffs, …)` ([page.tsx:322](../../cmd/next-app/src/app/site/[id]/page.tsx)), so multi-version metered date-resolution **never happens today** regardless of dates. Task 1 fixes this — it is the load-bearing change.
- **`effective_from` is only ever written for comparison plans** (`saveComparisonStructure`, [comparison-tariff-repo.ts:216](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)). `addTariffVersion` ([tariff-repo.ts:78](../../cmd/next-app/src/lib/tariff-repo.ts)) omits it from the INSERT — every metered version is null-dated.
- **`addTariffVersion` is called once**, from [importer/index.ts:336](../../cmd/next-app/src/lib/importer/index.ts), only when `tariff_content_v2` canonically changed. Inside the txn the next `version` number is computed as `MAX(version)+1` ([tariff-repo.ts:71](../../cmd/next-app/src/lib/tariff-repo.ts)); `version === 1` ⇒ first version for the site.
- **`localDateKey(ts, timeZone)`** ([battery-provenance/local-day.ts:2](../../cmd/next-app/src/lib/battery-provenance/local-day.ts)) → `'YYYY-MM-DD'`. The importer has the site tz at `info.installation_time_zone` ([importer/index.ts:327](../../cmd/next-app/src/lib/importer/index.ts)).
- **`Tariff` carries `version?`, `effective_from`, `reporting_only`, full `seasons[]`** ([site-repo.ts:156-165](../../cmd/next-app/src/lib/site-repo.ts), [db.ts:80](../../cmd/next-app/src/lib/db.ts)).
- **`classifyTariff(tariff): 'fixed' | 'tou'`** ([classify-tariff.ts:5](../../cmd/next-app/src/lib/roi/classify-tariff.ts)).
- **Repo tests mock `pool`** and assert SQL substrings + params; no live DB. See [tariff-repo.test.ts:32](../../cmd/next-app/src/lib/tariff-repo.test.ts) (client-query sequence via `clientQueryMock.mockImplementation`) and [comparison-tariff-repo.test.ts:7](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts) (`poolQueryMock`).
- **Route + manager patterns to mirror:** the comparison route [comparison-tariff/route.ts](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts) (authz via `verifySiteAccess`, `coverageError`, PATCH/POST) and [ComparisonTariffEditor.tsx](../../cmd/next-app/src/components/site/ComparisonTariffEditor.tsx) (injects `onSave`/`onClone` into `ScheduleEditor`; `SchedulePayload` = `{ name, effectiveFrom, seasons }`).
- **`coverageError`** is currently a private function in the comparison route ([comparison-tariff/route.ts:10](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts)); Task 5 extracts it to `tou-coverage.ts` so both routes share it.
- **Migration generator:** `npm run db:migration:create <name>` (writes `db-migrations/<timestamp>_<name>.sql`). Migrations must be idempotent; they are not unit-tested in this repo (CI runs them against a prod backup).

---

## File Structure

**Create:**
- `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts` — PATCH (set a version's effective date) + POST (add a historic version). Authz + coverage validation.
- `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts` — route tests.
- `cmd/next-app/src/components/site/MeteredTariffEditor.tsx` — the manager (list versions, edit date, add historic via `ScheduleEditor`).
- `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx` — component test.
- `cmd/next-app/db-migrations/<timestamp>_metered_effective_from_backfill.sql` — Part 2 backfill (generated).

**Modify:**
- `cmd/next-app/src/lib/tariff-repo.ts` — `addTariffVersion` gains a `detectionDate` param + writes `effective_from`; add `listMeteredVersions`, `setMeteredEffectiveFrom`, `addHistoricMeteredVersion`.
- `cmd/next-app/src/lib/tariff-repo.test.ts` — cover the new methods + the effective_from stamping.
- `cmd/next-app/src/lib/importer/index.ts` — pass the site-local detection date into `addTariffVersion`.
- `cmd/next-app/src/lib/roi/tou-coverage.ts` — export a shared `coverageError(seasons)`.
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts` — import `coverageError` from `tou-coverage` (drop the local copy).
- `cmd/next-app/src/app/site/[id]/page.tsx` — load metered versions; feed them to `meteredTimeline`; build version summaries; pass to `SavingsSettings`.
- `cmd/next-app/src/components/site/savings/SavingsSettings.tsx` — accept `meteredVersions` + render `MeteredTariffEditor`.

**Untouched (explicitly):** `plan-timeline.ts` (already date-resolves), `energy-repo.ts` (bill stays current-rate), `ScheduleEditor.tsx` (reused as-is).

---

## Task 1: Feed all metered versions into the savings timeline

Foundational: without this, multi-version metered never date-resolves, so the rest of the feature has no visible effect.

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`, `cmd/next-app/src/app/site/[id]/page.tsx`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cmd/next-app/src/lib/tariff-repo.test.ts`:

```ts
describe('TariffRepo.listMeteredVersions', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('selects all non-reporting versions (no is_current filter), newest effective_from first', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rows: [
            { tariff_id: 2, tariff_name: 'PG&E', tariff_updated: '2026-01-01', tariff_site_id: 'site-1',
              tariff_reporting_only: false, tariff_effective_from: '2026-01-01',
              season_id: 20, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.2, season_sell_rate: 0.05, schedule_id: 200, schedule_name: 'W',
              schedule_buy_rate: 0.2, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
            { tariff_id: 1, tariff_name: 'PG&E', tariff_updated: '2024-01-01', tariff_site_id: 'site-1',
              tariff_reporting_only: false, tariff_effective_from: null,
              season_id: 10, season_name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
              season_buy_rate: 0.1, season_sell_rate: 0.05, schedule_id: 100, schedule_name: 'W',
              schedule_buy_rate: 0.1, schedule_sell_rate: 0.05,
              from_day_of_week: 0, from_hour: 0, from_minute: 0, to_day_of_week: 6, to_hour: 24, to_minute: 0 },
        ] });

        const versions = await new TariffRepo().listMeteredVersions('site-1');

        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/NOT t\.reporting_only/);
        expect(sql).not.toMatch(/is_current/);
        expect(sql).toMatch(/effective_from DESC NULLS LAST/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1']);
        expect(versions).toHaveLength(2);
        expect(versions[0].effective_from).toBe('2026-01-01');
        expect(versions[0].seasons?.[0].schedules?.[0].buy_rate).toBe(0.2);
        expect(versions[1].effective_from).toBeNull();
    });
});
```

> Note: this `describe` uses `pool.query` (not the `clientQueryMock`). The top-of-file mock already exposes `pool.query` as a `vi.fn()`; `vi.clearAllMocks()` resets it each test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — `listMeteredVersions is not a function`.

- [ ] **Step 3: Implement `listMeteredVersions`**

In `cmd/next-app/src/lib/tariff-repo.ts`, change the imports on line 1 to include the season/schedule types:

```ts
import { pool, Tariff, TariffSchedule, TariffSeason } from './db';
```

Add this method to `TariffRepo` (after `getSchedulesForSite`, before the `// === Commands ===` block):

```ts
    /** All metered (non-reporting) versions for a site as full Tariff→Season→Schedule
     *  structures, newest effective_from first. Feeds the date-resolved metered timeline
     *  (site.tariffs is current-only, so the savings timeline needs this instead). */
    async listMeteredVersions(siteId: string): Promise<Tariff[]> {
        const res = await pool.query(
            `SELECT t.id AS tariff_id, t.name AS tariff_name, t.updated AS tariff_updated,
                    t.site_id AS tariff_site_id, t.reporting_only AS tariff_reporting_only,
                    t.effective_from::text AS tariff_effective_from, t.version AS tariff_version,
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
              WHERE t.site_id = $1 AND NOT t.reporting_only
              ORDER BY t.effective_from DESC NULLS LAST, t.version DESC, se.id, sc.id`,
            [siteId],
        );
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();
        const order: Tariff[] = [];
        for (const r of res.rows) {
            const tid = Number(r.tariff_id);
            if (!tariffMap.has(tid)) {
                const tariff: Tariff = {
                    id: tid, site_id: r.tariff_site_id as string, updated: new Date(r.tariff_updated as string | Date),
                    name: (r.tariff_name as string | null) ?? null, reporting_only: r.tariff_reporting_only === true,
                    effective_from: (r.tariff_effective_from as string | null) ?? null,
                    version: r.tariff_version != null ? Number(r.tariff_version) : undefined,
                    seasons: [],
                };
                tariffMap.set(tid, tariff);
                order.push(tariff);
            }
            const tariff = tariffMap.get(tid)!;
            const sid = Number(r.season_id);
            if (!seasonMap.has(sid)) {
                const season: TariffSeason = {
                    id: sid, tariff_id: tid, name: (r.season_name as string | null) ?? null,
                    from_month: Number(r.from_month), from_day: Number(r.from_day),
                    to_month: Number(r.to_month), to_day: Number(r.to_day),
                    buy_rate: Number(r.season_buy_rate), sell_rate: Number(r.season_sell_rate), schedules: [],
                };
                seasonMap.set(sid, season);
                tariff.seasons!.push(season);
            }
            if (r.schedule_id != null) {
                seasonMap.get(sid)!.schedules!.push({
                    id: Number(r.schedule_id), season_id: sid, name: (r.schedule_name as string | null) ?? null,
                    buy_rate: r.schedule_buy_rate != null ? Number(r.schedule_buy_rate) : null,
                    sell_rate: r.schedule_sell_rate != null ? Number(r.schedule_sell_rate) : null,
                    from_day_of_week: r.from_day_of_week as number | null, from_hour: r.from_hour as number | null,
                    from_minute: r.from_minute as number | null, to_day_of_week: r.to_day_of_week as number | null,
                    to_hour: r.to_hour as number | null, to_minute: r.to_minute as number | null,
                } as TariffSchedule);
            }
        }
        return order;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: PASS.

- [ ] **Step 5: Wire `page.tsx` to load + feed metered versions**

In `cmd/next-app/src/app/site/[id]/page.tsx`, inside the `if (baseline && roiConfig && …)` block, replace this line (around [page.tsx:322](../../cmd/next-app/src/app/site/[id]/page.tsx)):

```ts
        const meteredTl = meteredTimeline(finalSite.tariffs, finalSite.timezone);
```

with:

```ts
        const meteredVersions = await new TariffRepo().listMeteredVersions(finalSite.id);
        const meteredTl = meteredTimeline(meteredVersions, finalSite.timezone);
```

Ensure `TariffRepo` is imported at the top of `page.tsx`. If it is not already imported, add:

```ts
import { TariffRepo } from '@/lib/tariff-repo';
```

(Run `grep -n "TariffRepo" src/app/site/\[id\]/page.tsx` first; only add the import if absent.)

- [ ] **Step 6: Verify build + types**

Run: `cd cmd/next-app && npx tsc --noEmit && npm test -- src/lib/tariff-repo`
Expected: no type errors; tests pass.

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): feed all metered versions into the savings timeline (listMeteredVersions)"
```

---

## Task 2: Importer stamps effective_from (detection date) on new versions

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`, `cmd/next-app/src/lib/importer/index.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cmd/next-app/src/lib/tariff-repo.test.ts` (inside the existing `describe('TariffRepo.addTariffVersion', …)` or as a new describe — use a new describe to keep the `connectMock` setup explicit):

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

    it('stamps the detection date on a non-first version', async () => {
        mockSeq(3);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');
        const call = tariffInsertCall();
        expect(String(call[0])).toMatch(/effective_from/);
        expect(call[1]).toContain('2026-06-18');
    });

    it('leaves the first version (version 1) undated so it carries backward', async () => {
        mockSeq(1);
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');
        const call = tariffInsertCall();
        expect(call[1]).toContain(null);
        expect(call[1]).not.toContain('2026-06-18');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — `addTariffVersion` takes 2 args / INSERT has no `effective_from`.

- [ ] **Step 3: Implement the param + INSERT change**

In `cmd/next-app/src/lib/tariff-repo.ts`, change the `addTariffVersion` signature (line 45):

```ts
    async addTariffVersion(siteId: string, parsed: ParsedTariff, detectionDate: string): Promise<void> {
```

After the `version` is computed (line 75, `const version = verRes.rows[0].next;`), add:

```ts
            // First version carries backward (null); later versions are dated to detection (the
            // honest upper bound — Tesla's payload has no real effective date; user can correct it).
            const effectiveFrom = version === 1 ? null : detectionDate;
```

Change the `Tariff` INSERT (lines 78-83) to include the column + value:

```ts
            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, effective_from, updated)
                 VALUES ($1, $2, $3, true, $4, $5, NOW())
                 RETURNING id`,
                [siteId, parsed.name, version, newHash, effectiveFrom]
            );
```

- [ ] **Step 4: Update the importer caller**

In `cmd/next-app/src/lib/importer/index.ts`, add the import near the top (after line 10):

```ts
import { localDateKey } from '../battery-provenance/local-day';
```

Replace the call at [importer/index.ts:336](../../cmd/next-app/src/lib/importer/index.ts):

```ts
                await this.tariffRepo.addTariffVersion(siteId, parsed);
```

with:

```ts
                const detectionDate = localDateKey(new Date(), info.installation_time_zone);
                await this.tariffRepo.addTariffVersion(siteId, parsed, detectionDate);
```

- [ ] **Step 5: Fix the existing addTariffVersion tests**

The two pre-existing tests in `describe('TariffRepo.addTariffVersion', …)` call `addTariffVersion('site-1', parsed)` with 2 args. Update both call sites to pass a detection date:

```ts
        await new TariffRepo().addTariffVersion('site-1', parsed, '2026-06-18');
```

(The no-op test's assertions still hold — it returns before the INSERT.)

- [ ] **Step 6: Run tests + types**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo && npx tsc --noEmit`
Expected: PASS; no type errors (importer now passes 3 args).

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts cmd/next-app/src/lib/importer/index.ts
git commit -m "feat(roi): stamp detection-date effective_from on new metered versions"
```

---

## Task 3: Backfill migration for existing null-dated versions

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_metered_effective_from_backfill.sql` (generated)

- [ ] **Step 1: Generate the migration file**

Run: `cd cmd/next-app && npm run db:migration:create metered_effective_from_backfill`
Expected: prints the created path `db-migrations/<timestamp>_metered_effective_from_backfill.sql`.

- [ ] **Step 2: Write the migration SQL**

Replace the generated file's contents with:

```sql
-- Backfill effective_from for metered (non-reporting) Tariff versions that predate
-- effective-date stamping. Per site, leave the earliest version null (it carries backward),
-- and date every later null version to its own detection timestamp (Tariff.updated).
-- Idempotent: after running, the affected rows are no longer null, so a re-run is a no-op.
-- Comparison plans (reporting_only) are never touched — they own their dates.
UPDATE "Tariff" t
SET effective_from = t.updated::date
WHERE NOT t.reporting_only
  AND t.effective_from IS NULL
  AND t.version > (
    SELECT MIN(m.version)
    FROM "Tariff" m
    WHERE m.site_id = t.site_id AND NOT m.reporting_only
  );
```

- [ ] **Step 3: Sanity-check the SQL locally (optional, requires DB)**

If a local/dev Postgres is configured (`DATABASE_URL`), apply the migration and verify the invariant — at most one null metered version per site, and it is the lowest version:

```bash
cd cmd/next-app
# After applying migrations to your dev DB, check no site has a null metered version that is not its earliest:
psql "$DATABASE_URL" -c "SELECT site_id, version, effective_from FROM \"Tariff\" t WHERE NOT reporting_only AND effective_from IS NULL AND version > (SELECT MIN(version) FROM \"Tariff\" m WHERE m.site_id = t.site_id AND NOT m.reporting_only);"
```

Expected: 0 rows.

> Migrations are not unit-tested in this repo; CI applies them against a prod backup on PR (per CLAUDE.md). Keep the SQL idempotent.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/*_metered_effective_from_backfill.sql
git commit -m "feat(roi): backfill effective_from for existing metered versions"
```

---

## Task 4: Metered repo writes — set-date and add-historic-version

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`
- Test: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cmd/next-app/src/lib/tariff-repo.test.ts`:

```ts
describe('TariffRepo.setMeteredEffectiveFrom', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('updates one metered version effective_from, guarded to non-reporting', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rowCount: 1 });
        await new TariffRepo().setMeteredEffectiveFrom('site-1', 3, '2025-09-01');
        const sql = String(poolQuery.mock.calls[0][0]);
        expect(sql).toMatch(/UPDATE "Tariff" SET effective_from/);
        expect(sql).toMatch(/NOT reporting_only/);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 3, '2025-09-01']);
    });
    it('accepts null to clear a date', async () => {
        const poolQuery = (await import('./db')).pool.query as ReturnType<typeof vi.fn>;
        poolQuery.mockResolvedValue({ rowCount: 1 });
        await new TariffRepo().setMeteredEffectiveFrom('site-1', 1, null);
        expect(poolQuery.mock.calls[0][1]).toEqual(['site-1', 1, null]);
    });
});

describe('TariffRepo.addHistoricMeteredVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    });
    it('inserts a non-current metered version dated in the past, named like the current plan', async () => {
        clientQueryMock.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT name')) return { rows: [{ name: 'PG&E' }] };
            if (sql.includes('MAX(version)')) return { rows: [{ next: 4 }] };
            if (sql.includes('INSERT INTO "Tariff"')) return { rows: [{ id: 9 }] };
            if (sql.includes('INSERT INTO "TariffSeason"')) return { rows: [{ id: 90 }] };
            return { rows: [] };
        });

        await new TariffRepo().addHistoricMeteredVersion('site-1', parsed, '2022-01-01');

        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        // does NOT demote the current Tesla version
        expect(sqls.some(s => s.includes('is_current = false'))).toBe(false);
        const insert = clientQueryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "Tariff"'))!;
        expect(String(insert[0])).toMatch(/reporting_only/);
        expect(String(insert[0])).toMatch(/effective_from/);
        // params: site, name (from current), version, content_hash, effective_from
        expect(insert[1]).toEqual(expect.arrayContaining(['site-1', 'PG&E', 4, '2022-01-01']));
        // inserted as not-current, not reporting-only (literals in the VALUES clause)
        expect(String(insert[0])).toMatch(/false,\s*false/);
        expect(sqls.some(s => s.includes('COMMIT'))).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement both methods**

In `cmd/next-app/src/lib/tariff-repo.ts`, add to `TariffRepo` (after `addTariffVersion`):

```ts
    /** Correct/set a metered version's effective date (the date-resolution boundary).
     *  Guarded to non-reporting so it can never touch a comparison plan. */
    async setMeteredEffectiveFrom(siteId: string, version: number, effectiveFrom: string | null): Promise<void> {
        await pool.query(
            `UPDATE "Tariff" SET effective_from = $3, updated = NOW()
              WHERE site_id = $1 AND version = $2 AND NOT reporting_only`,
            [siteId, version, effectiveFrom],
        );
    }

    /** Insert a user-authored historic metered version: a past plan the importer never saw.
     *  Shares the current metered plan's name, is NOT current (the Tesla version stays current),
     *  and is reporting_only = false so the metered timeline includes it. Date drives ordering,
     *  not the (monotonic) version number. */
    async addHistoricMeteredVersion(siteId: string, parsed: ParsedTariff, effectiveFrom: string): Promise<void> {
        const newHash = tariffContentHash(parsed);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            // Name the historic version after the current metered plan (same plan, earlier in time).
            const nameRes = await client.query(
                `SELECT name FROM "Tariff" WHERE site_id = $1 AND is_current AND NOT reporting_only LIMIT 1`,
                [siteId],
            );
            const planName = (nameRes.rows[0]?.name as string | undefined) ?? parsed.name;

            const verRes = await client.query(
                'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
                [siteId],
            );
            const version = verRes.rows[0].next;

            const tariffRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, content_hash, effective_from, updated)
                 VALUES ($1, $2, $3, false, false, $4, $5, NOW())
                 RETURNING id`,
                [siteId, planName, version, newHash, effectiveFrom],
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
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd cmd/next-app && npm test -- src/lib/tariff-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts
git commit -m "feat(roi): metered repo writes — set effective date + add historic version"
```

---

## Task 5: Shared coverage validation + metered API route

**Files:**
- Modify: `cmd/next-app/src/lib/roi/tou-coverage.ts`, `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts`, `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts`

- [ ] **Step 1: Extract `coverageError` into `tou-coverage.ts`**

In `cmd/next-app/src/lib/roi/tou-coverage.ts`, add (it already exports `seasonCalendarGaps` and `windowCoverage`; ensure `ParsedSeason` is imported there — add `import type { ParsedSeason } from '../importer/tariff-parser';` if absent):

```ts
/** First human-readable coverage problem in a structure, or null when fully covered.
 *  Shared by the comparison and metered tariff routes. */
export function coverageError(seasons: ParsedSeason[]): string | null {
    if (!Array.isArray(seasons) || seasons.length === 0) return 'At least one season is required.';
    const calGaps = seasonCalendarGaps(seasons);
    if (calGaps.length > 0) {
        const g = calGaps[0];
        return g.count === 0
            ? `No season covers ${g.month}/${g.day} — every day of the year must belong to a season.`
            : `${g.month}/${g.day} is covered by ${g.count} seasons — seasons must not overlap.`;
    }
    for (const s of seasons) {
        const { gaps } = windowCoverage(s);
        if (gaps.length > 0) {
            const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const c = gaps[0];
            return `Season "${s.name}" leaves ${days[c.weekday]} ${String(c.hour).padStart(2, '0')}:00 unpriced — every hour must be covered by a window.`;
        }
    }
    return null;
}
```

- [ ] **Step 2: Point the comparison route at the shared helper**

In `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts`, delete the local `coverageError` function (lines 9-28) and add it to the existing `tou-coverage` import:

```ts
import { seasonCalendarGaps, windowCoverage, coverageError } from '@/lib/roi/tou-coverage';
```

(If `seasonCalendarGaps`/`windowCoverage` are no longer referenced directly in the route after removing the local function, drop them from the import to satisfy lint — keep only `coverageError`.)

- [ ] **Step 3: Write the failing route test**

Create `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyMock, setDateMock, addHistoricMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), setDateMock: vi.fn(), addHistoricMock: vi.fn(),
}));
vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/tariff-repo', () => ({
    TariffRepo: vi.fn(() => ({ setMeteredEffectiveFrom: setDateMock, addHistoricMeteredVersion: addHistoricMock })),
}));

import { PATCH, POST } from './route';

function req(body: unknown) {
    return new Request('http://test/api/site/s1/metered-tariff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}
const params = Promise.resolve({ id: 's1' });
const fullYearSeasons = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.05,
    schedules: [{ name: 'W', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
}];

beforeEach(() => { vi.clearAllMocks(); verifyMock.mockResolvedValue(true); });

describe('metered-tariff PATCH', () => {
    it('403 without access', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await PATCH(req({ version: 2, effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(403);
    });
    it('sets a version effective date', async () => {
        const res = await PATCH(req({ version: 2, effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(200);
        expect(setDateMock).toHaveBeenCalledWith('s1', 2, '2025-09-01');
    });
    it('400 when version missing', async () => {
        const res = await PATCH(req({ effective_from: '2025-09-01' }), { params });
        expect(res.status).toBe(400);
    });
});

describe('metered-tariff POST (add historic version)', () => {
    it('400 on a coverage gap', async () => {
        const res = await POST(req({ effective_from: '2022-01-01', seasons: [] }), { params });
        expect(res.status).toBe(400);
        expect(addHistoricMock).not.toHaveBeenCalled();
    });
    it('creates a historic version', async () => {
        const res = await POST(req({ effective_from: '2022-01-01', seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(200);
        expect(addHistoricMock).toHaveBeenCalledWith('s1', expect.objectContaining({ seasons: fullYearSeasons }), '2022-01-01');
    });
    it('400 when effective_from missing (historic versions must be dated)', async () => {
        const res = await POST(req({ seasons: fullYearSeasons }), { params });
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/app/api/site/\\[id\\]/metered-tariff`
Expected: FAIL — `./route` has no `PATCH`/`POST` (module not found).

- [ ] **Step 5: Implement the route**

Create `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TariffRepo } from '@/lib/tariff-repo';
import { coverageError } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

/** Correct/set the effective date of one metered version. */
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
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    await new TariffRepo().setMeteredEffectiveFrom(id, version, effectiveFrom);
    return NextResponse.json({ success: true });
}

/** Add a user-authored historic metered version (a past plan the importer never saw). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    if (!effectiveFrom) {
        return NextResponse.json({ error: 'A historic version needs an effective date.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    // name is derived from the current metered plan inside the repo; pass seasons as the parsed structure.
    await new TariffRepo().addHistoricMeteredVersion(id, { name: '', seasons }, effectiveFrom);
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 6: Run tests + lint**

Run: `cd cmd/next-app && npm test -- src/app/api/site/\\[id\\]/metered-tariff src/app/api/site/\\[id\\]/comparison-tariff && npm run lint`
Expected: PASS; lint clean (no unused imports in the comparison route).

- [ ] **Step 7: Commit**

```bash
git add cmd/next-app/src/lib/roi/tou-coverage.ts cmd/next-app/src/app/api/site/\[id\]/comparison-tariff/route.ts cmd/next-app/src/app/api/site/\[id\]/metered-tariff/
git commit -m "feat(roi): metered-tariff route (set date + add historic) with shared coverageError"
```

---

## Task 6: Metered plan history manager component + wiring

**Files:**
- Create: `cmd/next-app/src/components/site/MeteredTariffEditor.tsx`, `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx`
- Modify: `cmd/next-app/src/components/site/savings/SavingsSettings.tsx`, `cmd/next-app/src/app/site/[id]/page.tsx`

- [ ] **Step 1: Define the version-summary type + build it in `page.tsx`**

In `cmd/next-app/src/app/site/[id]/page.tsx`, after `const meteredVersions = await new TariffRepo().listMeteredVersions(finalSite.id);` (added in Task 1), build a serializable summary for the client component:

```ts
        const meteredVersionSummaries = meteredVersions.map(t => ({
            version: t.version ?? 0,
            effective_from: t.effective_from ?? null,
            is_current: t.id === activeTariffId,
            kind: classifyTariff(t),
            buy_rate: t.seasons?.[0]?.schedules?.[0]?.buy_rate ?? t.seasons?.[0]?.buy_rate ?? 0,
        }));
```

> `classifyTariff` is already imported in `page.tsx` (used for the grid). `activeTariffId` is already in scope (used to find the active tariff above). These summaries are passed down through `SavingsSettings`.

Note: `meteredVersionSummaries` is built inside the `if (baseline && roiConfig && …)` block. Declare a `let meteredVersionSummaries: MeteredVersionSummary[] = [];` alongside the other `let` declarations (near `let roiSummary = null;`) and assign inside the block, so it is always defined when rendering `SavingsSettings`. Import the type:

```ts
import type { MeteredVersionSummary } from '@/components/site/MeteredTariffEditor';
```

- [ ] **Step 2: Write the failing component test**

Create `cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeteredTariffEditor, type MeteredVersionSummary } from './MeteredTariffEditor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const versions: MeteredVersionSummary[] = [
    { version: 2, effective_from: '2026-01-01', is_current: true, kind: 'tou', buy_rate: 0.3 },
    { version: 1, effective_from: null, is_current: false, kind: 'fixed', buy_rate: 0.16 },
];

describe('MeteredTariffEditor', () => {
    it('lists metered versions with their effective dates, newest first', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toContain('2026-01-01');
        expect(html).toContain('current');
        // the undated earliest version is presented as the carry-back anchor
        expect(html).toMatch(/from the beginning/i);
        // TOU current version shows a TOU badge; the fixed one shows a rate
        expect(html).toContain('TOU');
        expect(html).toContain('0.16');
    });

    it('offers an "add historic plan" action', () => {
        const html = renderToStaticMarkup(<MeteredTariffEditor siteId="s1" versions={versions} />);
        expect(html).toMatch(/add historic plan/i);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd cmd/next-app && npm test -- src/components/site/MeteredTariffEditor`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the component**

Create `cmd/next-app/src/components/site/MeteredTariffEditor.tsx`:

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

export function MeteredTariffEditor({ siteId, versions }: { siteId: string; versions: MeteredVersionSummary[] }) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/metered-tariff`;

    const [busy, setBusy] = useState(false);
    const [editingDate, setEditingDate] = useState<number | null>(null); // version being date-edited
    const [dateValue, setDateValue] = useState('');
    const [adding, setAdding] = useState(false);

    // earliest = lowest version number (carry-back anchor; may be undated)
    const earliestVersion = versions.reduce((min, v) => Math.min(min, v.version), Infinity);

    async function send(method: string, body: unknown, okMsg: string): Promise<boolean> {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 400 || res.status === 409) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('request failed');
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
        const ok = await send('POST', { effective_from: payload.effectiveFrom || null, seasons: payload.seasons }, 'Historic plan added.');
        if (ok) setAdding(false);
        return ok;
    }

    if (adding) {
        return (
            <Card>
                <CardHeader><CardTitle>Add a historic plan</CardTitle>
                    <CardDescription>Enter a metered plan that was in effect in the past. Set the date it took effect — it prices your history before your current plan.</CardDescription>
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

    return (
        <Card>
            <CardHeader><CardTitle>Metered plan history</CardTitle>
                <CardDescription>Your real plan over time. Rates come from Tesla; set when each version took effect so your savings price each period correctly.</CardDescription>
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
                                    {v.effective_from ?? (v.version === earliestVersion ? 'from the beginning' : 'undated')}
                                    {v.is_current ? ' · current' : ''}
                                </span>
                                <button type="button" tabIndex={0} disabled={busy}
                                    onClick={() => { setEditingDate(v.version); setDateValue(v.effective_from ?? ''); }}
                                    className="ml-auto text-xs text-primary hover:underline rounded px-1">Set date</button>
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

- [ ] **Step 5: Run the component test to verify it passes**

Run: `cd cmd/next-app && npm test -- src/components/site/MeteredTariffEditor`
Expected: PASS.

- [ ] **Step 6: Wire into `SavingsSettings`**

In `cmd/next-app/src/components/site/savings/SavingsSettings.tsx`, add the import:

```tsx
import { MeteredTariffEditor, type MeteredVersionSummary } from '@/components/site/MeteredTariffEditor';
```

Add `meteredVersions` to the props type and destructure it:

```tsx
  meteredVersions,
```
```tsx
  meteredVersions: MeteredVersionSummary[];
```

Render it just below the `ComparisonTariffEditor` inside the open panel:

```tsx
          <ComparisonTariffEditor siteId={siteId} plans={comparisonPlans} meteredPlanName={meteredPlanName} meteredPlanVersion={meteredPlanVersion} />
          <MeteredTariffEditor siteId={siteId} versions={meteredVersions} />
```

- [ ] **Step 7: Pass the summaries from `page.tsx`**

Find where `SavingsSettings` is rendered in `page.tsx` (`grep -n "SavingsSettings" src/app/site/\[id\]/page.tsx`) and add the prop:

```tsx
            meteredVersions={meteredVersionSummaries}
```

- [ ] **Step 8: Verify build, types, lint**

Run: `cd cmd/next-app && npx tsc --noEmit && npm run lint && npm test -- src/components/site/MeteredTariffEditor`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add cmd/next-app/src/components/site/MeteredTariffEditor.tsx cmd/next-app/src/components/site/MeteredTariffEditor.test.tsx cmd/next-app/src/components/site/savings/SavingsSettings.tsx cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): metered plan history manager — edit dates + add historic versions"
```

---

## Task 7: Final verification

- [ ] **Step 1:** `cd cmd/next-app && npm test` — all pass.
- [ ] **Step 2:** `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit` — all pass.
- [ ] **Step 3: Confirm the metered timeline is fed all versions.** `cd cmd/next-app && grep -n "meteredTimeline(" src/app/site/\[id\]/page.tsx` → expected: the argument is `meteredVersions` (not `finalSite.tariffs`).
- [ ] **Step 4: Confirm `coverageError` has a single home.** `cd cmd/next-app && grep -rn "function coverageError" src` → expected: exactly one match, in `tou-coverage.ts`.
- [ ] **Step 5 (optional, live):** on a site whose Tesla tariff changed during observation, open Savings → Savings settings → "Metered plan history"; set the change date; confirm the payback hero / grid metered column re-prices history at the older rate before that date.
- [ ] **Step 6:** `git push origin feat/roi` (only when the user asks).

---

## Self-review notes (for the implementer)

- **Every commit builds.** Task 1 adds the loader and swaps the timeline input (multi-version metered now date-resolves). Tasks 2-6 layer on dating + authoring. No task removes a symbol another still needs.
- **The invariant** (≤1 null metered version, the earliest) is established by Task 2 (first version null) + Task 3 (backfill), surfaced by Task 6 ("from the beginning"), and maintained by the manager (date-edit is how you make room before the earliest). A user prepending a plan earlier than an undated earliest version should first set that version's date — the manager shows it as "from the beginning" to make this legible.
- **Bill view untouched** — `energy-repo` keeps pricing with the current tariff (out of scope per spec).
- **Tesla content stays Tesla's** — synced versions are rate-read-only in the manager; only their effective date is editable. Historic versions are fully user-authored and named after the current metered plan so they belong to the same timeline.
- **`addHistoricMeteredVersion` does not demote `is_current`** — the current Tesla version stays current; the historic version is a non-current, past-dated row that the metered timeline still includes (it filters by `reporting_only`, not `is_current`).
