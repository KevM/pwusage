# ROI Comparison Plans as Reporting-Only Tariffs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `SiteRoiConfig` fixed-rate scalars with a first-class **comparison plan** — a `Tariff` flagged `reporting_only`, priced read-side and never metered — entered through a new editor with a Fixed/TOU toggle and a captured (display-only) rate timeline.

**Architecture:** Add `reporting_only` + `effective_from` columns to `Tariff`. Exclude reporting-only tariffs from *all* metered pricing at one shared SQL boundary (`SiteRepo.loadSitesFromDB`), so the 9 `new Schedule(...)` consumers need zero changes. A dedicated `ComparisonTariffRepo` loads/writes reporting-only Fixed plans (per-name append versioning, minting a full-year/all-week flat chain). The ROI read side resolves the current Fixed comparison's flat rate via `resolveFixedBaseline` and feeds the unchanged `computeMatrixTotals`. Effective dates are captured and displayed/ordered only — pricing uses the current version, with an honest "not yet applied" note.

**Tech Stack:** Next.js (App Router), TypeScript, PostgreSQL (`pg` pool), Vitest (tests mock the `db` pool — no live DB), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-13-roi-comparison-tariffs-design.md`. Follow-ons F1/F2 in `TODO.md` are out of scope.

**Conventions to mirror:**
- Tables are quoted PascalCase identifiers (`"Tariff"`). Migrations are idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Tesla weekday encoding: `from_day_of_week=0 .. to_day_of_week=6` means every day (see `TariffList.tsx` / `schedule.ts`).
- Repo tests mock `./db` `pool` with `vi.hoisted` + `vi.mock` and assert SQL/params (see `src/lib/tariff-repo.test.ts`). Pure-logic tests import the function directly (see `src/lib/roi/roi-service.test.ts`).
- Run a single test file: `npm test -- src/lib/roi/comparison-tariff-repo` (Vitest path filter).

---

## File Structure

**Create:**
- `cmd/next-app/db-migrations/<timestamp>_roi_reporting_tariffs.sql` — `Tariff.reporting_only` + `Tariff.effective_from` + fill-if-blank name.
- `cmd/next-app/src/lib/roi/fixed-comparison.ts` — pure builder: flat-rate inputs → `ParsedTariff` (the flat chain).
- `cmd/next-app/src/lib/roi/fixed-comparison.test.ts`
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts` — load/append/uniqueness for reporting-only Fixed plans.
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts` — current Fixed comparison → `RoiInputs | null`.
- `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts`
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts` — POST create/append + 409 on metered-name conflict.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx` — the Fixed/TOU toggle editor + timeline + honest note.

**Modify:**
- `cmd/next-app/src/lib/db.ts` — add `reporting_only` + `effective_from` to `Tariff`.
- `cmd/next-app/src/lib/site-repo.ts` — `loadSitesFromDB` join gains `AND NOT t.reporting_only`; select `t.effective_from`/`t.reporting_only` onto the assembled `Tariff`.
- `cmd/next-app/src/lib/site-repo.test.ts` — assert the exclusion clause (create file if absent — see Task 3).
- `cmd/next-app/src/app/site/[id]/page.tsx:291-318` — swap scalar read for `resolveFixedBaseline`; thread plan names into `SavingsView`.
- `cmd/next-app/src/components/site/savings/SavingsView.tsx` — accept + pass `fixedPlanName` / `meteredPlanName`.
- `cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx` — column subtitles show plan names.
- `cmd/next-app/src/components/site/RoiConfigForm.tsx` — drop the two fixed-rate fields (keep costs/dates).
- `cmd/next-app/src/app/api/site/[id]/roi-config/route.ts` — stop writing `fixed_buy_rate`/`fixed_sell_rate`.
- `cmd/next-app/src/components/site/SettingsView.tsx` — render `ComparisonTariffEditor`.

---

## Task 1: Migration — `reporting_only` + `effective_from` + fill-if-blank name

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_roi_reporting_tariffs.sql` (via generator)

- [ ] **Step 1: Generate the migration file**

Run: `cd cmd/next-app && npm run db:migration:create roi_reporting_tariffs`
Expected: prints a new path `db-migrations/<timestamp>_roi_reporting_tariffs.sql`.

- [ ] **Step 2: Write the migration SQL**

Replace the generated file's contents with:

```sql
-- ROI comparison plans: tariffs can be reporting-only (priced read-side, never
-- metered) and carry an effective_from date (captured for display/ordering this
-- phase; date-resolved pricing is deferred — see F1/F2 in TODO.md).
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS reporting_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS effective_from DATE NULL;

-- Friendly label for the metered base plan, only where it has none. Never
-- clobbers a real imported utility name. Touches only blank/whitespace names.
UPDATE "Tariff" SET name = 'Standard'
 WHERE reporting_only = false
   AND (name IS NULL OR btrim(name) = '');
```

- [ ] **Step 3: Verify the SQL parses (lint the file visually) and the build is unaffected**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds (migrations are not run by build; this confirms no accidental edits broke compilation).

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/
git commit -m "feat(roi): Tariff.reporting_only + effective_from + fill-if-blank name"
```

---

## Task 2: Add `reporting_only` + `effective_from` to the `Tariff` type

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts` (the `Tariff` interface, ~line 75)

- [ ] **Step 1: Extend the `Tariff` interface**

In `src/lib/db.ts`, replace the `Tariff` interface with:

```ts
export interface Tariff {
  id: number;
  site_id: string;
  updated: Date;
  name: string | null;
  reporting_only?: boolean;        // true ⇒ comparison plan, excluded from metered pricing
  effective_from?: string | null;  // 'YYYY-MM-DD'; display/ordering only this phase
  seasons?: TariffSeason[];
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd cmd/next-app && npx tsc --noEmit`
Expected: no new errors (optional fields are additive).

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/lib/db.ts
git commit -m "feat(roi): add reporting_only + effective_from to Tariff type"
```

---

## Task 3: Exclude reporting-only tariffs from the metered SQL boundary

`SiteRepo.loadSitesFromDB` is the single loader feeding all 9 `new Schedule(...)` sites (it already filters `AND t.is_current`). Adding `AND NOT t.reporting_only` there makes every metered consumer correct with no other changes.

**Files:**
- Modify: `cmd/next-app/src/lib/site-repo.ts` (the `loadSitesFromDB` SQL, ~line 109)
- Test: `cmd/next-app/src/lib/site-repo.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `src/lib/site-repo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import { SiteRepo } from './site-repo';

describe('SiteRepo metered tariff loading', () => {
    beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }); });

    it('excludes reporting-only tariffs from the loaded site', async () => {
        await new SiteRepo().getSite('site-1');
        const sql = String(queryMock.mock.calls[0][0]);
        expect(sql).toMatch(/Tariff".*ON.*is_current/s);
        expect(sql).toMatch(/NOT\s+t\.reporting_only/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/site-repo`
Expected: FAIL — `expect(sql).toMatch(/NOT\s+t\.reporting_only/)` does not match.

- [ ] **Step 3: Add the exclusion clause**

In `src/lib/site-repo.ts`, change the Tariff join line:

```
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id AND t.is_current
```

to:

```
            LEFT JOIN "Tariff"         t   ON t.site_id     = s.id AND t.is_current AND NOT t.reporting_only
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/site-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-repo.test.ts
git commit -m "feat(roi): exclude reporting-only tariffs from metered site load"
```

---

## Task 4: Pure builder for the flat comparison chain (the day-of-week gotcha)

**Files:**
- Create: `cmd/next-app/src/lib/roi/fixed-comparison.ts`
- Test: `cmd/next-app/src/lib/roi/fixed-comparison.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/fixed-comparison.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFixedComparisonInput } from './fixed-comparison';
import { Schedule } from '../schedule';
import type { Tariff } from '../db';

function asTariff(parsed: ReturnType<typeof buildFixedComparisonInput>): Tariff {
    return {
        id: 1, site_id: 's1', updated: new Date(), name: parsed.name,
        reporting_only: true, effective_from: null,
        seasons: parsed.seasons.map((s, si) => ({
            id: si + 1, tariff_id: 1, name: s.name,
            from_month: s.from_month, from_day: s.from_day, to_month: s.to_month, to_day: s.to_day,
            buy_rate: s.buy_rate, sell_rate: s.sell_rate,
            schedules: s.schedules.map((sc, ci) => ({
                id: ci + 1, season_id: si + 1, name: sc.name,
                buy_rate: sc.buy_rate, sell_rate: sc.sell_rate,
                from_day_of_week: sc.from_day_of_week, to_day_of_week: sc.to_day_of_week,
                from_hour: sc.from_hour, from_minute: sc.from_minute, to_hour: sc.to_hour, to_minute: sc.to_minute,
            })),
        })),
    };
}

describe('buildFixedComparisonInput', () => {
    it('uses 0..6 day-of-week so every day matches (the gotcha)', () => {
        const sched = buildFixedComparisonInput({ name: 'Flat', buyRate: 0.2, sellRate: 0.05 }).seasons[0].schedules[0];
        expect(sched.from_day_of_week).toBe(0);
        expect(sched.to_day_of_week).toBe(6);
    });

    it('resolves a non-null period for a Wednesday 03:00 and a Sunday 20:00', () => {
        const tariff = asTariff(buildFixedComparisonInput({ name: 'Flat', buyRate: 0.2, sellRate: 0.05 }));
        const schedule = new Schedule([tariff], 'UTC');
        const wed = new Date('2026-01-07T03:00:00Z'); // Wednesday
        const sun = new Date('2026-01-04T20:00:00Z'); // Sunday
        expect(schedule.getTariffPeriod(wed)).not.toBeNull();
        expect(schedule.getTariffPeriod(sun)).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/fixed-comparison`
Expected: FAIL — `buildFixedComparisonInput` is not defined.

- [ ] **Step 3: Implement the builder**

Create `src/lib/roi/fixed-comparison.ts`:

```ts
import type { ParsedTariff } from '../importer/tariff-parser';

export interface FixedComparisonInput {
    name: string;
    buyRate: number;
    sellRate: number;
}

/** A flat plan = one full-year season + one all-day/all-week schedule.
 *  Day-of-week MUST be 0..6: matchDayOfWeek returns false when both bounds are
 *  null, so null-day bounds would match zero days. Hours 0..24 cover all hours. */
export function buildFixedComparisonInput(input: FixedComparisonInput): ParsedTariff {
    return {
        name: input.name,
        seasons: [{
            name: 'All Year',
            from_month: 1, from_day: 1, to_month: 12, to_day: 31,
            buy_rate: input.buyRate, sell_rate: input.sellRate,
            schedules: [{
                name: 'Flat',
                buy_rate: input.buyRate, sell_rate: input.sellRate,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
            }],
        }],
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/fixed-comparison`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/fixed-comparison.ts cmd/next-app/src/lib/roi/fixed-comparison.test.ts
git commit -m "feat(roi): flat comparison-tariff builder with 0..6 day-of-week"
```

---

## Task 5: `ComparisonTariffRepo` — load, append, metered-name check

Per-name append versioning (demote the prior current version *for that name only*, unlike `TariffRepo.addTariffVersion` which demotes site-wide). Writes `reporting_only = true` and `effective_from`.

**Files:**
- Create: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, clientQueryMock, releaseMock, poolQueryMock } = vi.hoisted(() => ({
    connectMock: vi.fn(), clientQueryMock: vi.fn(), releaseMock: vi.fn(), poolQueryMock: vi.fn(),
}));

vi.mock('../db', () => ({ pool: { connect: connectMock, query: poolQueryMock } }));

import { ComparisonTariffRepo } from './comparison-tariff-repo';

function sqlOf(call: unknown[]): string { return String(call[0]); }

describe('ComparisonTariffRepo.appendFixedComparison', () => {
    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [{ next: 1, id: 42 }] });
    });

    it('demotes only the same-named current version, then inserts a reporting-only version with effective_from', async () => {
        await new ComparisonTariffRepo().appendFixedComparison('site-1', {
            name: 'PG&E flat', buyRate: 0.1658, sellRate: 0.08, effectiveFrom: '2024-01-01',
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const demote = sqls.find(s => s.includes('SET is_current = false'));
        expect(demote).toMatch(/name = \$2/);
        expect(demote).toMatch(/reporting_only/);
        const insert = sqls.find(s => s.includes('INSERT INTO "Tariff"'));
        expect(insert).toMatch(/reporting_only/);
        expect(insert).toMatch(/effective_from/);
    });
});

describe('ComparisonTariffRepo.nameInUseByMetered', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('returns true when a current metered tariff already has the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ exists: true }] });
        const used = await new ComparisonTariffRepo().nameInUseByMetered('site-1', 'Standard');
        expect(used).toBe(true);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/NOT reporting_only/);
        expect(sql).toMatch(/is_current/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `ComparisonTariffRepo` is not defined.

- [ ] **Step 3: Implement the repo**

Create `src/lib/roi/comparison-tariff-repo.ts`:

```ts
import { pool } from '../db';
import { buildFixedComparisonInput } from './fixed-comparison';

export interface FixedComparisonInputRow {
    name: string;
    buyRate: number;
    sellRate: number;
    effectiveFrom: string | null; // 'YYYY-MM-DD'
}

export interface ComparisonVersion {
    version: number;
    is_current: boolean;
    effective_from: string | null;
    buy_rate: number;
    sell_rate: number;
}

export interface ComparisonPlan {
    name: string;
    versions: ComparisonVersion[]; // newest effective_from first
}

export class ComparisonTariffRepo {
    /** Append a reporting-only Fixed version for (site, name); demote the prior
     *  current version of that same name only. Mints a full-year flat season +
     *  all-day/all-week schedule. */
    async appendFixedComparison(siteId: string, input: FixedComparisonInputRow): Promise<void> {
        // Single source of the flat chain (incl. the 0..6 day-of-week gotcha), tested in fixed-comparison.test.ts.
        const chain = buildFixedComparisonInput({ name: input.name, buyRate: input.buyRate, sellRate: input.sellRate });
        const season = chain.seasons[0];
        const sched = season.schedules[0];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            await client.query(
                `UPDATE "Tariff" SET is_current = false
                  WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current`,
                [siteId, input.name],
            );

            const verRes = await client.query(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff"
                  WHERE site_id = $1 AND name = $2`,
                [siteId, input.name],
            );
            const version = verRes.rows[0].next;

            const tRes = await client.query(
                `INSERT INTO "Tariff"(site_id, name, version, is_current, reporting_only, effective_from, updated)
                 VALUES ($1, $2, $3, true, true, $4, NOW()) RETURNING id`,
                [siteId, input.name, version, input.effectiveFrom],
            );
            const tariffId = tRes.rows[0].id;

            const sRes = await client.query(
                `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate],
            );
            const seasonId = sRes.rows[0].id;

            await client.query(
                `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [seasonId, sched.name, sched.buy_rate, sched.sell_rate, sched.from_day_of_week, sched.to_day_of_week, sched.from_hour, sched.from_minute, sched.to_hour, sched.to_minute],
            );

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    /** True when a *metered* current tariff already uses this name (would collide
     *  with the (site_id, name) WHERE is_current unique index). */
    async nameInUseByMetered(siteId: string, name: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT EXISTS(
                SELECT 1 FROM "Tariff"
                 WHERE site_id = $1 AND name = $2 AND is_current AND NOT reporting_only
             ) AS exists`,
            [siteId, name],
        );
        return res.rows[0]?.exists === true;
    }

    /** All reporting-only Fixed plans for a site, grouped by name, newest first. */
    async listFixedComparisons(siteId: string): Promise<ComparisonPlan[]> {
        const res = await pool.query(
            `SELECT t.name, t.version, t.is_current, t.effective_from::text AS effective_from,
                    se.buy_rate, se.sell_rate
               FROM "Tariff" t
               JOIN "TariffSeason" se ON se.tariff_id = t.id
              WHERE t.site_id = $1 AND t.reporting_only
              ORDER BY t.name ASC, t.effective_from DESC NULLS LAST, t.version DESC`,
            [siteId],
        );
        const byName = new Map<string, ComparisonPlan>();
        for (const r of res.rows) {
            const name = r.name as string;
            if (!byName.has(name)) byName.set(name, { name, versions: [] });
            byName.get(name)!.versions.push({
                version: Number(r.version),
                is_current: r.is_current === true,
                effective_from: r.effective_from ?? null,
                buy_rate: Number(r.buy_rate),
                sell_rate: Number(r.sell_rate),
            });
        }
        return Array.from(byName.values());
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): ComparisonTariffRepo append/list/name-check"
```

---

## Task 6: `resolveFixedBaseline` — current Fixed comparison → RoiInputs

**Files:**
- Create: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts`
- Test: `cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/roi/resolve-fixed-baseline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickCurrentFixedBaseline } from './resolve-fixed-baseline';
import type { ComparisonPlan } from './comparison-tariff-repo';

describe('pickCurrentFixedBaseline', () => {
    it('returns the current version of the (latest) plan as RoiInputs', () => {
        const plans: ComparisonPlan[] = [{
            name: 'PG&E flat',
            versions: [
                { version: 2, is_current: true, effective_from: '2026-01-01', buy_rate: 0.19342, sell_rate: 0.08 },
                { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.16580, sell_rate: 0.08 },
            ],
        }];
        expect(pickCurrentFixedBaseline(plans)).toEqual({ fixedBuyRate: 0.19342, fixedSellRate: 0.08 });
    });

    it('returns null when there is no comparison plan', () => {
        expect(pickCurrentFixedBaseline([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: FAIL — `pickCurrentFixedBaseline` is not defined.

- [ ] **Step 3: Implement**

Create `src/lib/roi/resolve-fixed-baseline.ts`:

```ts
import type { RoiInputs } from './roi-service';
import { ComparisonTariffRepo, type ComparisonPlan } from './comparison-tariff-repo';

/** Pure: pick the current version of the most-recent Fixed comparison plan.
 *  v1 prices the matrix Fixed column from a single baseline; if multiple plans
 *  exist, the one with the most-recent current effective_from wins. */
export function pickCurrentFixedBaseline(plans: ComparisonPlan[]): RoiInputs | null {
    let best: { eff: string; v: ComparisonPlan['versions'][number] } | null = null;
    for (const plan of plans) {
        const current = plan.versions.find(v => v.is_current);
        if (!current) continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, v: current };
    }
    if (!best) return null;
    return { fixedBuyRate: best.v.buy_rate, fixedSellRate: best.v.sell_rate };
}

export async function resolveFixedBaseline(siteId: string): Promise<RoiInputs | null> {
    const plans = await new ComparisonTariffRepo().listFixedComparisons(siteId);
    return pickCurrentFixedBaseline(plans);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/resolve-fixed-baseline`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/resolve-fixed-baseline.ts cmd/next-app/src/lib/roi/resolve-fixed-baseline.test.ts
git commit -m "feat(roi): resolveFixedBaseline from current Fixed comparison plan"
```

---

## Task 7: POST `/api/site/[id]/comparison-tariff` (create/append + 409 conflict)

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/site/[id]/comparison-tariff/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { ComparisonTariffRepo } from '@/lib/roi/comparison-tariff-repo';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const buyRate = Number(body.buy_rate);
    const sellRate = Number(body.sell_rate);
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;

    if (!name || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, buy_rate and sell_rate are required' }, { status: 400 });
    }

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }

    await repo.appendFixedComparison(id, { name, buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd cmd/next-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add cmd/next-app/src/app/api/site/
git commit -m "feat(roi): comparison-tariff create/append API route"
```

---

## Task 8: Read-side swap — price the Fixed column from the comparison plan

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx:291-318`

- [ ] **Step 1: Read the current block**

Open `src/app/site/[id]/page.tsx` lines ~291-318. The existing logic reads `roiConfig.fixed_buy_rate`/`fixed_sell_rate` into `configInputs` and gates on them.

- [ ] **Step 2: Add the import**

Near the other roi imports (around line 28):

```ts
import { resolveFixedBaseline } from '@/lib/roi/resolve-fixed-baseline';
```

- [ ] **Step 3: Replace the rate source and gate**

Replace the block that currently looks like:

```ts
    if (roiConfig && roiConfig.fixed_buy_rate != null && roiConfig.fixed_sell_rate != null
        && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
        const configInputs = { fixedBuyRate: roiConfig.fixed_buy_rate, fixedSellRate: roiConfig.fixed_sell_rate };
        roiSummary = buildRoiSummary(
```

with:

```ts
    const fixedBaseline = await resolveFixedBaseline(finalSite.id);
    if (fixedBaseline && roiConfig && (roiConfig.solar_cost != null || roiConfig.battery_cost != null)) {
        const configInputs = fixedBaseline;
        roiSummary = buildRoiSummary(
```

Leave the remaining arguments to `buildRoiSummary(...)` unchanged.

- [ ] **Step 4: Verify build**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds. (No `roiSummary` for sites without a comparison plan — the existing empty state renders, unchanged.)

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): price Fixed column from comparison plan, not config scalars"
```

---

## Task 9: Matrix column subtitles show plan names

**Files:**
- Modify: `cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx`
- Modify: `cmd/next-app/src/components/site/savings/SavingsView.tsx`
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx` (pass names to `SavingsView`)

- [ ] **Step 1: Add optional name props to `ScenarioMatrix`**

In `ScenarioMatrix.tsx`, change the component signature and the column headers:

```tsx
export function ScenarioMatrix({ summary, fixedPlanName, meteredPlanName }: {
    summary: RoiSummary; fixedPlanName?: string; meteredPlanName?: string;
}) {
```

Replace the two header cells:

```tsx
            <div className="text-center text-xs font-semibold opacity-70 flex flex-col items-center justify-center">
                <span>Fixed</span>{fixedPlanName && <span className="font-normal opacity-80">{fixedPlanName}</span>}
            </div>
            <div className="text-center text-xs font-semibold opacity-70 flex flex-col items-center justify-center">
                <span>TOU</span>{meteredPlanName && <span className="font-normal opacity-80">{meteredPlanName}</span>}
            </div>
```

- [ ] **Step 2: Thread the props through `SavingsView`**

In `SavingsView.tsx`, add `fixedPlanName` and `meteredPlanName` to its props type, and pass them to `<ScenarioMatrix summary={...} fixedPlanName={fixedPlanName} meteredPlanName={meteredPlanName} />`. (Match the existing prop-passing style in that file.)

- [ ] **Step 3: Supply the names from `page.tsx`**

Where `page.tsx` renders `SavingsView`, pass:
- `meteredPlanName={finalSite.tariffs?.[0]?.name ?? 'Your plan'}`
- `fixedPlanName` = the current Fixed comparison plan's name (add a `listFixedComparisons` call, or reuse one already loaded). Minimal: import `ComparisonTariffRepo`, `const fixedPlans = await new ComparisonTariffRepo().listFixedComparisons(finalSite.id); const fixedPlanName = fixedPlans[0]?.name;` and pass it.

- [ ] **Step 4: Verify build**

Run: `cd cmd/next-app && npm run build`
Expected: build succeeds; matrix headers render names when present.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/savings/ScenarioMatrix.tsx cmd/next-app/src/components/site/savings/SavingsView.tsx cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): label matrix columns with concrete plan names"
```

---

## Task 10: Comparison-tariff editor UI + Settings wiring; remove fixed fields from RoiConfigForm

**Files:**
- Create: `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx`
- Modify: `cmd/next-app/src/components/site/RoiConfigForm.tsx`
- Modify: `cmd/next-app/src/app/api/site/[id]/roi-config/route.ts`

- [ ] **Step 1: Build the editor component**

Create `src/components/site/ComparisonTariffEditor.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

export function ComparisonTariffEditor({ siteId, plans, meteredPlanName }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const [mode, setMode] = useState<'fixed' | 'tou'>('fixed');
    const [form, setForm] = useState({ name: '', buy_rate: '', sell_rate: '', effective_from: '' });
    const [saving, setSaving] = useState(false);
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    async function save() {
        setSaving(true);
        try {
            const res = await fetch(`/api/site/${siteId}/comparison-tariff`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
            });
            if (res.status === 409) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('save failed');
            toast({ title: 'Saved', description: 'Comparison plan updated.', variant: 'success' });
            setForm({ name: '', buy_rate: '', sell_rate: '', effective_from: '' });
            router.refresh();
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
        } finally { setSaving(false); }
    }

    return (
        <Card>
            <CardHeader><CardTitle>Comparison plans</CardTitle>
                <CardDescription>Baselines the savings matrix prices against. Your metered plan ({meteredPlanName}) is managed under Tariff Information.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {plans.map(plan => (
                    <div key={plan.name} className="rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        <div className="font-medium">{plan.name}</div>
                        <div className="mt-2 space-y-1 text-sm">
                            {plan.versions.map(v => (
                                <div key={v.version} className="flex items-center gap-3">
                                    <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>
                                    <span className="text-gray-500 dark:text-gray-400">{v.effective_from ?? 'undated'}{v.is_current ? ' · current' : ''}</span>
                                </div>
                            ))}
                        </div>
                        {plan.versions.length > 1 && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                Past rates are captured for ordering only — savings still use the current rate. Date-based pricing arrives in a later update.
                            </p>
                        )}
                    </div>
                ))}

                <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Add comparison plan</span>
                        <div className="ml-auto inline-flex rounded-md border border-gray-300 dark:border-slate-700 overflow-hidden text-sm">
                            <button type="button" onClick={() => setMode('fixed')}
                                className={`px-3 py-1 ${mode === 'fixed' ? 'bg-primary/10 text-primary' : 'text-gray-500'}`}>Fixed</button>
                            <button type="button" onClick={() => setMode('tou')}
                                className={`px-3 py-1 ${mode === 'tou' ? 'bg-primary/10 text-primary' : 'text-gray-500'}`}>TOU</button>
                        </div>
                    </div>
                    {mode === 'tou' ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            TOU comparison plans arrive in a later update. For now the TOU column uses your metered plan ({meteredPlanName}).
                        </p>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1"><Label>Plan name</Label><Input value={form.name} onChange={set('name')} /></div>
                                <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={form.effective_from} onChange={set('effective_from')} /></div>
                                <div className="flex flex-col gap-1"><Label>Buy rate $/kWh</Label><Input type="number" step="0.00001" value={form.buy_rate} onChange={set('buy_rate')} /></div>
                                <div className="flex flex-col gap-1"><Label>Sell rate $/kWh</Label><Input type="number" step="0.00001" value={form.sell_rate} onChange={set('sell_rate')} /></div>
                            </div>
                            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
                        </>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 2: Drop the fixed-rate fields from `RoiConfigForm`**

In `RoiConfigForm.tsx`: remove `fixed_buy_rate` and `fixed_sell_rate` from the `useState` initial object, and remove their two `field(...)` renders (find the two `field('... rate ...', 'fixed_buy_rate'|'fixed_sell_rate', ...)` lines). Keep solar/battery cost + install date fields.

- [ ] **Step 3: Stop persisting the fixed scalars in the roi-config route**

In `src/app/api/site/[id]/roi-config/route.ts`, remove the two lines:

```ts
        fixed_buy_rate: num(body.fixed_buy_rate),
        fixed_sell_rate: num(body.fixed_sell_rate),
```

and pass `fixed_buy_rate: null, fixed_sell_rate: null` to `upsert(...)` instead (the columns are deprecated; keep the `SiteRoiConfig` type satisfied):

```ts
        fixed_buy_rate: null,
        fixed_sell_rate: null,
```

- [ ] **Step 4: Render the editor in `SettingsView` and supply its data**

In `SettingsView.tsx`: import `ComparisonTariffEditor`, add a `comparisonPlans?: ComparisonPlan[]` prop to `SettingsViewProps`, and render `<ComparisonTariffEditor siteId={site.id} plans={comparisonPlans ?? []} meteredPlanName={site.tariffs?.[0]?.name ?? 'Standard'} />` directly after `<RoiConfigForm .../>` (line ~321). Then in `page.tsx`, where `SettingsView` is rendered (line ~382), pass `comparisonPlans={fixedPlans}` (the `listFixedComparisons` result from Task 9 Step 3 — reuse the same call).

- [ ] **Step 5: Verify build + lint**

Run: `cd cmd/next-app && npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/components/site/ComparisonTariffEditor.tsx cmd/next-app/src/components/site/SettingsView.tsx cmd/next-app/src/components/site/RoiConfigForm.tsx cmd/next-app/src/app/api/site/\[id\]/roi-config/route.ts cmd/next-app/src/app/site/\[id\]/page.tsx
git commit -m "feat(roi): comparison-tariff editor UI; drop fixed scalars from config form"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass, including the new `fixed-comparison`, `comparison-tariff-repo`, `resolve-fixed-baseline`, and `site-repo` tests.

- [ ] **Step 2: Build + lint**

Run: `cd cmd/next-app && npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 3: Manual smoke (optional, dev server)**

Run: `cd cmd/next-app && npm run dev:agent` (port 5174). In Settings: add a Fixed comparison plan; confirm it lists with its effective date; add a second rate for the same plan name and confirm the "captured for ordering only" note appears and pricing is unchanged; confirm the Savings matrix Fixed column header shows the plan name and the TOU header shows the metered plan name.

- [ ] **Step 4: Commit any final fixups**

```bash
git add -A && git commit -m "test(roi): verify comparison-tariff foundation green"
```

---

## Self-review notes (for the implementer)

- **Exclusion correctness:** Task 3 is the load-bearing safety change. After it, no metered `Schedule` can see a reporting-only tariff — verify the `site-repo` test asserts `NOT t.reporting_only`.
- **The gotcha:** Task 4's second test (Wed 03:00 + Sun 20:00 non-null) is the regression guard for the `0..6` day-of-week requirement. Do not weaken it to a single timestamp.
- **No date-resolved pricing this phase:** `pickCurrentFixedBaseline` deliberately ignores per-row dates and uses the current version only. The "not yet applied" note (Task 10) must render whenever a plan has >1 version.
- **Deprecated columns:** `SiteRoiConfig.fixed_buy_rate`/`fixed_sell_rate` are intentionally left in the schema and type; the route writes `null`. Do not add a migration to drop them.
