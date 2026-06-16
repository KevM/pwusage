# Flexible Matrix — Phase D (Manager CRUD): Comparison-Plan Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the minimal "add a Fixed comparison plan" editor into a real manager: edit a version's rates/effective-date, delete a version (promoting a new current when needed), delete a whole plan, and append a new effective-dated version to an existing plan — all guarded so a metered tariff is never touched.

**Architecture:** Comparison plans are `reporting_only` Tariff rows (Fixed-only today: one season + one all-week/all-day schedule, both carrying the buy/sell rate). This phase extends `ComparisonTariffRepo` with `editComparisonVersion`, `deleteComparisonVersion`, `deleteComparisonPlan`, and a `comparisonNameInUse` validation helper; adds `PATCH`/`DELETE` handlers (and a create-vs-append `intent` to the existing `POST`) to the comparison-tariff route; and rebuilds `ComparisonTariffEditor` with per-version edit/delete, per-plan delete, and a per-plan "+ add version" affordance. **The pricing engine, the extended grid, and the metered `TariffRepo` are untouched** — this is CRUD over the existing reporting-only substrate.

**Tech Stack:** Next.js (App Router) route handlers, TypeScript, `pg` Pool, Tailwind, Vitest. Repo tests mock `../db` (`vi.hoisted` connect/query mocks) and assert on SQL strings + the `reporting_only` guard. Route tests mock `@/lib/auth-checks` + the repo class. The component test uses `renderToStaticMarkup` with `next/navigation` and `@/components/ui/Toast` mocked (the suite runs under `environment: 'node'`, so there is no RTL/jsdom — assert on the rendered HTML string).

**Spec:** `docs/superpowers/specs/2026-06-15-flexible-comparison-matrix-design.md` — Phase D, "Plan management" (decision 10). This is the **manager-CRUD slice only**. The **clone-and-tweak TOU authoring** and **historical metered entry** halves are deferred to their own follow-on plans and are NOT in scope here. Plan **rename** is also deferred (per-version edit covers the substantive content; renaming touches the `(site_id, name)` indexes and is a separate, smaller change).

**Conventions to mirror:**
- Repo tests: `src/lib/roi/comparison-tariff-repo.test.ts` — `vi.hoisted({ connectMock, clientQueryMock, releaseMock, poolQueryMock })`, `vi.mock('../db', …)`, `sqlOf(call) = String(call[0])`, assert SQL substrings.
- Route tests: `src/app/api/site/[id]/battery-hold/route.test.ts` — `vi.mock('@/lib/auth-checks', …)`, mock the repo class, `req(body) = { json: async () => body }`, `ctx = { params: Promise.resolve({ id: 'site-1' }) }`.
- Component test: `vi.mock('next/navigation', …)` + `vi.mock('@/components/ui/Toast', …)`, then `renderToStaticMarkup(<ComparisonTariffEditor … />)` and assert on the HTML string.
- All commands run from `cmd/next-app`.

---

## Key facts grounding this plan (verified against the code)

- **Comparison plans are `reporting_only` Tariff rows.** `appendFixedComparison` ([comparison-tariff-repo.ts:28](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)) inserts one `Tariff(reporting_only=true)` → one `TariffSeason` → one `TariffSchedule`; the buy/sell rate is written on **both** the season and the schedule. So editing a Fixed version's rate must `UPDATE` both rows.
- **`EnergyData.tariff_id → Tariff` is `ON DELETE CASCADE`** ([20260524_120000_tariff_versioning.sql:4](../../cmd/next-app/db-migrations/20260524_120000_tariff_versioning.sql)). Deleting a *metered* tariff would cascade-wipe `EnergyData`. Comparison plans are `reporting_only` and **never referenced by `EnergyData`**, so every delete/edit MUST carry a `reporting_only` guard in its `WHERE`. This is the load-bearing safety invariant of this plan.
- **`TariffSeason → Tariff` and `TariffSchedule → TariffSeason` are `ON DELETE CASCADE`** ([20260123000001_init_schema.sql:45,58](../../cmd/next-app/db-migrations/20260123000001_init_schema.sql)). Deleting a `Tariff` row drops its season+schedule automatically — no manual child deletes needed.
- **`tariff_current_uidx` = `UNIQUE (site_id, name) WHERE is_current`** ([20260524_120000_tariff_versioning.sql:29](../../cmd/next-app/db-migrations/20260524_120000_tariff_versioning.sql)). At most one current version per `(site_id, name)`. When deleting the current version of a multi-version plan we must promote exactly one remaining version to `is_current=true`, or the plan vanishes from `listFixedComparisons` (which has no fallback to non-current rows per name — it lists all rows, but the editor/grid treat the current one as live).
- **`listFixedComparisons`** ([comparison-tariff-repo.ts:94](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)) returns `ComparisonPlan[]` = `{ name, versions: ComparisonVersion[] }`, versions newest-`effective_from`-first. The editor and grid already consume this shape; the new CRUD does not change it.
- **The route** ([route.ts](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts)) currently exports only `POST` (create/append). It guards `nameInUseByMetered` and returns `409` on collision. We add `PATCH`/`DELETE` and a create-vs-append `intent`.
- **`ComparisonTariffEditor`** ([ComparisonTariffEditor.tsx](../../cmd/next-app/src/components/site/ComparisonTariffEditor.tsx)) is a `'use client'` component using `useRouter()` + `useToast()`; it lists plans read-only and has one create form. It carries a now-stale amber note ("Date-based pricing arrives in a later update") — date-resolved pricing shipped in Phase C/D, so this note is corrected here.
- **Test env is `environment: 'node'`** (vitest.config.ts) with no `@testing-library/react`/jsdom. Component tests render to a static string and assert on HTML.

---

## File Structure

**Modify:**
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts` — add `editComparisonVersion`, `deleteComparisonVersion`, `deleteComparisonPlan`, `comparisonNameInUse` (+ `EditVersionInput` type).
- `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts` — cover the four new methods.
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts` — add `PATCH` + `DELETE`; add `intent` create-vs-append validation to `POST`.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx` — per-version edit/delete, per-plan delete, per-plan "+ add version"; correct the stale note.

**Create:**
- `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.test.ts` — route handler tests.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx` — render test for the new controls.

**Untouched (explicitly):** `fixed-comparison.ts` (the flat-chain builder is reused as-is by append), `roi-service.ts`, `extended-grid.ts`, `plan-timeline.ts`, `tariff-repo.ts` (metered lineage; historical-metered entry is a deferred phase), `page.tsx` (it already passes `comparisonPlans` + `meteredPlanName` to `SavingsSettings → ComparisonTariffEditor`; no new props needed).

---

## Task 1: `editComparisonVersion`

Edit one reporting-only Fixed version's rates + `effective_from`. The rate lives on both the season and the schedule, so both update. `reporting_only` guard prevents touching a metered tariff.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.editComparisonVersion', () => {
    beforeEach(() => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        // Tariff UPDATE returns the row id; subsequent UPDATEs return empty.
        clientQueryMock.mockResolvedValue({ rows: [{ id: 42 }], rowCount: 1 });
    });

    it('updates the Tariff effective_from and both season + schedule rates, guarded reporting_only', async () => {
        await new ComparisonTariffRepo().editComparisonVersion('site-1', 'EV Plan', 2, {
            buyRate: 0.31, sellRate: 0.06, effectiveFrom: '2025-06-01',
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const tariffUpd = sqls.find(s => s.includes('UPDATE "Tariff"'));
        expect(tariffUpd).toMatch(/effective_from/);
        expect(tariffUpd).toMatch(/reporting_only/);
        expect(tariffUpd).toMatch(/RETURNING id/);
        expect(sqls.some(s => s.includes('UPDATE "TariffSeason"'))).toBe(true);
        expect(sqls.some(s => s.includes('UPDATE "TariffSchedule"'))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('rolls back without touching children when the version is not a reporting-only match', async () => {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockResolvedValue({ rows: [], rowCount: 0 }); // Tariff UPDATE matched nothing
        await new ComparisonTariffRepo().editComparisonVersion('site-1', 'Metered', 1, {
            buyRate: 0.5, sellRate: 0, effectiveFrom: null,
        });
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('UPDATE "TariffSeason"'))).toBe(false);
        expect(sqls).toContain('ROLLBACK');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `editComparisonVersion` is not a function.

- [ ] **Step 3: Implement `editComparisonVersion`**

In `src/lib/roi/comparison-tariff-repo.ts`, add this interface just below the existing `FixedComparisonInputRow` interface (after line 9):

```ts
export interface EditVersionInput {
    buyRate: number;
    sellRate: number;
    effectiveFrom: string | null; // 'YYYY-MM-DD'
}
```

Add this method inside the `ComparisonTariffRepo` class (after `appendFixedComparison`, before `nameInUseByMetered`):

```ts
    /** Edit one reporting-only Fixed comparison version's rates + effective_from.
     *  A Fixed plan carries its rate on BOTH the season and its schedule, so update
     *  both. Guarded `reporting_only` so a metered tariff is never touched; a non-match
     *  rolls back. */
    async editComparisonVersion(siteId: string, name: string, version: number, input: EditVersionInput): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const tRes = await client.query(
                `UPDATE "Tariff" SET effective_from = $4, updated = NOW()
                  WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                  RETURNING id`,
                [siteId, name, version, input.effectiveFrom],
            );
            if (tRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
            const tariffId = tRes.rows[0].id;

            await client.query(
                `UPDATE "TariffSeason" SET buy_rate = $2, sell_rate = $3 WHERE tariff_id = $1`,
                [tariffId, input.buyRate, input.sellRate],
            );
            await client.query(
                `UPDATE "TariffSchedule" SET buy_rate = $2, sell_rate = $3
                  WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)`,
                [tariffId, input.buyRate, input.sellRate],
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS — both new cases and the pre-existing `appendFixedComparison`/`nameInUseByMetered` cases.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): editComparisonVersion — edit a reporting-only comparison version"
```

---

## Task 2: `deleteComparisonVersion` (with current-promotion)

Delete one reporting-only version (cascade drops its season/schedule). If it was the current version, promote the latest remaining version of the same name to current.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.deleteComparisonVersion', () => {
    function setup(deletedRow: { is_current: boolean } | null) {
        clientQueryMock.mockReset();
        connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
        clientQueryMock.mockImplementation((sql: string) => {
            if (String(sql).includes('DELETE FROM "Tariff"')) {
                return Promise.resolve(deletedRow ? { rows: [deletedRow], rowCount: 1 } : { rows: [], rowCount: 0 });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
    }

    it('deletes guarded by reporting_only and promotes the latest remaining when the current version was removed', async () => {
        setup({ is_current: true });
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'EV Plan', 2);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        const del = sqls.find(s => s.includes('DELETE FROM "Tariff"'))!;
        expect(del).toMatch(/reporting_only/);
        expect(del).toMatch(/RETURNING is_current/);
        const promote = sqls.find(s => s.includes('SET is_current = true'))!;
        expect(promote).toMatch(/ORDER BY effective_from DESC NULLS LAST, version DESC/);
        expect(promote).toMatch(/reporting_only/);
        expect(sqls).toContain('COMMIT');
    });

    it('does not promote when the deleted version was not current', async () => {
        setup({ is_current: false });
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'EV Plan', 1);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('SET is_current = true'))).toBe(false);
        expect(sqls).toContain('COMMIT');
    });

    it('rolls back when nothing matched (e.g. a metered version)', async () => {
        setup(null);
        await new ComparisonTariffRepo().deleteComparisonVersion('site-1', 'Metered', 1);
        const sqls = clientQueryMock.mock.calls.map(sqlOf);
        expect(sqls.some(s => s.includes('SET is_current = true'))).toBe(false);
        expect(sqls).toContain('ROLLBACK');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `deleteComparisonVersion` is not a function.

- [ ] **Step 3: Implement `deleteComparisonVersion`**

Add this method to `ComparisonTariffRepo` (after `editComparisonVersion`):

```ts
    /** Delete one reporting-only comparison version (cascade drops its season/schedule).
     *  If it was the current version, promote the latest remaining version of the same
     *  name to current. Guarded `reporting_only` so EnergyData's metered tariff can never
     *  be cascade-deleted. A non-match rolls back. */
    async deleteComparisonVersion(siteId: string, name: string, version: number): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

            const del = await client.query(
                `DELETE FROM "Tariff"
                  WHERE site_id = $1 AND name = $2 AND version = $3 AND reporting_only
                  RETURNING is_current`,
                [siteId, name, version],
            );
            if (del.rowCount === 0) { await client.query('ROLLBACK'); return; }

            if (del.rows[0].is_current === true) {
                await client.query(
                    `UPDATE "Tariff" SET is_current = true
                      WHERE id = (
                        SELECT id FROM "Tariff"
                         WHERE site_id = $1 AND name = $2 AND reporting_only
                         ORDER BY effective_from DESC NULLS LAST, version DESC
                         LIMIT 1)`,
                    [siteId, name],
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): deleteComparisonVersion — drop a version, promote a new current"
```

---

## Task 3: `deleteComparisonPlan` + `comparisonNameInUse`

Delete every version of a plan (one guarded statement), and add the create-time validation helper so "add new plan" can't silently append a version to an existing comparison plan.

**Files:**
- Modify: `cmd/next-app/src/lib/roi/comparison-tariff-repo.ts`
- Test: `cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/roi/comparison-tariff-repo.test.ts`:

```ts
describe('ComparisonTariffRepo.deleteComparisonPlan', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('deletes all reporting-only versions for the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [], rowCount: 2 });
        await new ComparisonTariffRepo().deleteComparisonPlan('site-1', 'EV Plan');
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/DELETE FROM "Tariff"/);
        expect(sql).toMatch(/reporting_only/);
        expect(sql).not.toMatch(/version/); // whole plan, not a single version
        expect(poolQueryMock.mock.calls[0][1]).toEqual(['site-1', 'EV Plan']);
    });
});

describe('ComparisonTariffRepo.comparisonNameInUse', () => {
    beforeEach(() => { poolQueryMock.mockReset(); });
    it('returns true when a current comparison plan already has the name', async () => {
        poolQueryMock.mockResolvedValue({ rows: [{ exists: true }] });
        const used = await new ComparisonTariffRepo().comparisonNameInUse('site-1', 'EV Plan');
        expect(used).toBe(true);
        const sql = sqlOf(poolQueryMock.mock.calls[0]);
        expect(sql).toMatch(/reporting_only/);
        expect(sql).toMatch(/is_current/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: FAIL — `deleteComparisonPlan` / `comparisonNameInUse` are not functions.

- [ ] **Step 3: Implement both methods**

Add to `ComparisonTariffRepo` (after `deleteComparisonVersion`):

```ts
    /** Delete an entire reporting-only comparison plan (all versions; cascade drops
     *  their seasons/schedules). Guarded `reporting_only`. */
    async deleteComparisonPlan(siteId: string, name: string): Promise<void> {
        await pool.query(
            `DELETE FROM "Tariff" WHERE site_id = $1 AND name = $2 AND reporting_only`,
            [siteId, name],
        );
    }

    /** True when a *current comparison* plan already uses this name, so "add new plan"
     *  doesn't silently append a version to an existing plan (use "+ add version" for that). */
    async comparisonNameInUse(siteId: string, name: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT EXISTS(
                SELECT 1 FROM "Tariff"
                 WHERE site_id = $1 AND name = $2 AND reporting_only AND is_current
             ) AS exists`,
            [siteId, name],
        );
        return res.rows[0]?.exists === true;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/roi/comparison-tariff-repo`
Expected: PASS — all repo describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/roi/comparison-tariff-repo.ts cmd/next-app/src/lib/roi/comparison-tariff-repo.test.ts
git commit -m "feat(roi): deleteComparisonPlan + comparisonNameInUse validation"
```

---

## Task 4: Route — `PATCH` + `DELETE`, and `intent` on `POST`

Wire the new repo methods to HTTP. `PATCH` edits a version; `DELETE` removes a version (body has `version`) or a whole plan (no `version`); `POST` gains an `intent` so "create" rejects an existing comparison name while "append-version" allows it.

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts`
- Test (create): `cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/site/[id]/comparison-tariff/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, appendMock, editMock, delVersionMock, delPlanMock, meteredMock, compMock } = vi.hoisted(() => ({
    verifyMock: vi.fn(), appendMock: vi.fn(), editMock: vi.fn(),
    delVersionMock: vi.fn(), delPlanMock: vi.fn(), meteredMock: vi.fn(), compMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/roi/comparison-tariff-repo', () => ({
    ComparisonTariffRepo: class {
        appendFixedComparison = appendMock;
        editComparisonVersion = editMock;
        deleteComparisonVersion = delVersionMock;
        deleteComparisonPlan = delPlanMock;
        nameInUseByMetered = meteredMock;
        comparisonNameInUse = compMock;
    },
}));

import { POST, PATCH, DELETE } from './route';

function req(body?: unknown) { return { json: async () => body } as unknown as Request; }
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

describe('comparison-tariff route', () => {
    beforeEach(() => {
        verifyMock.mockReset(); appendMock.mockReset(); editMock.mockReset();
        delVersionMock.mockReset(); delPlanMock.mockReset(); meteredMock.mockReset(); compMock.mockReset();
        verifyMock.mockResolvedValue(true);
        meteredMock.mockResolvedValue(false);
        compMock.mockResolvedValue(false);
    });

    it('POST 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await POST(req({ name: 'X', buy_rate: 0.1, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(403);
    });

    it('POST create appends and returns success', async () => {
        const res = await POST(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0.05, effective_from: '2025-01-01' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(appendMock).toHaveBeenCalled();
    });

    it('POST create 409 when the name is an existing comparison plan', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(409);
        expect(appendMock).not.toHaveBeenCalled();
    });

    it('POST append-version skips the comparison-name check and appends', async () => {
        compMock.mockResolvedValue(true);
        const res = await POST(req({ intent: 'append-version', name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(appendMock).toHaveBeenCalled();
    });

    it('POST 409 when the name collides with the metered plan', async () => {
        meteredMock.mockResolvedValue(true);
        const res = await POST(req({ name: 'Standard', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(409);
    });

    it('PATCH edits a version', async () => {
        const res = await PATCH(req({ name: 'EV', version: 2, buy_rate: 0.31, sell_rate: 0.06, effective_from: '2025-06-01' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(editMock).toHaveBeenCalledWith('site-1', 'EV', 2, { buyRate: 0.31, sellRate: 0.06, effectiveFrom: '2025-06-01' });
    });

    it('PATCH 400 on a missing/invalid version', async () => {
        const res = await PATCH(req({ name: 'EV', buy_rate: 0.3, sell_rate: 0 }) as never, ctx as never);
        expect(res.status).toBe(400);
        expect(editMock).not.toHaveBeenCalled();
    });

    it('DELETE with a version removes that version', async () => {
        const res = await DELETE(req({ name: 'EV', version: 1 }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delVersionMock).toHaveBeenCalledWith('site-1', 'EV', 1);
        expect(delPlanMock).not.toHaveBeenCalled();
    });

    it('DELETE without a version removes the whole plan', async () => {
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(200);
        expect(delPlanMock).toHaveBeenCalledWith('site-1', 'EV');
        expect(delVersionMock).not.toHaveBeenCalled();
    });

    it('DELETE 400 when the name is missing', async () => {
        const res = await DELETE(req({}) as never, ctx as never);
        expect(res.status).toBe(400);
    });

    it('DELETE 403 when unauthorized', async () => {
        verifyMock.mockResolvedValue(false);
        const res = await DELETE(req({ name: 'EV' }) as never, ctx as never);
        expect(res.status).toBe(403);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- comparison-tariff/route`
Expected: FAIL — `PATCH`/`DELETE` are not exported and the `intent`/`comparisonNameInUse` behavior is absent.

- [ ] **Step 3: Implement the route**

Replace the whole body of `src/app/api/site/[id]/comparison-tariff/route.ts` with:

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
    const intent = body.intent === 'append-version' ? 'append-version' : 'create';

    if (!name || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, buy_rate and sell_rate are required' }, { status: 400 });
    }

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }
    if (intent === 'create' && (await repo.comparisonNameInUse(id, name))) {
        return NextResponse.json({ error: `"${name}" already exists — use "+ add version" on that plan instead.` }, { status: 409 });
    }

    await repo.appendFixedComparison(id, { name, buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const version = Number(body.version);
    const buyRate = Number(body.buy_rate);
    const sellRate = Number(body.sell_rate);
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;

    if (!name || !Number.isInteger(version) || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, version, buy_rate and sell_rate are required' }, { status: 400 });
    }

    await new ComparisonTariffRepo().editComparisonVersion(id, name, version, { buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const repo = new ComparisonTariffRepo();
    if (body.version === undefined || body.version === null) {
        await repo.deleteComparisonPlan(id, name);
    } else {
        const version = Number(body.version);
        if (!Number.isInteger(version)) {
            return NextResponse.json({ error: 'version must be an integer' }, { status: 400 });
        }
        await repo.deleteComparisonVersion(id, name, version);
    }
    return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- comparison-tariff/route`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/api/site/\[id\]/comparison-tariff/route.ts cmd/next-app/src/app/api/site/\[id\]/comparison-tariff/route.test.ts
git commit -m "feat(api): comparison-tariff PATCH/DELETE + create-vs-append intent"
```

---

## Task 5: `ComparisonTariffEditor` — edit/delete/append-version controls

Rebuild the editor: each version row gains **Edit** (inline rate/date form → `PATCH`) and **Delete** (→ `DELETE` with `version`); each plan gains **Delete plan** (→ `DELETE` without `version`) and **+ add version** (the Fixed form, name locked, `intent: 'append-version'`). The create form sends `intent: 'create'`. Correct the stale "Date-based pricing arrives in a later update" note.

**Files:**
- Modify: `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx`
- Test (create): `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/site/ComparisonTariffEditor.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ComparisonTariffEditor } from './ComparisonTariffEditor';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';

const plans: ComparisonPlan[] = [
    { name: 'EV Plan', versions: [
        { version: 2, is_current: true, effective_from: '2025-06-01', buy_rate: 0.30, sell_rate: 0.05 },
        { version: 1, is_current: false, effective_from: '2024-01-01', buy_rate: 0.20, sell_rate: 0.04 },
    ] },
];

describe('ComparisonTariffEditor', () => {
    it('renders the plan name and each version', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).toContain('EV Plan');
        expect(html).toContain('2025-06-01');
        expect(html).toContain('2024-01-01');
    });

    it('exposes per-version edit + delete and per-plan controls', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).toMatch(/edit/i);
        expect(html).toMatch(/delete/i);
        expect(html).toMatch(/add version/i);
    });

    it('does not carry the stale "date-based pricing arrives" note', () => {
        const html = renderToStaticMarkup(<ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" />);
        expect(html).not.toMatch(/Date-based pricing arrives/i);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: FAIL — controls / note assertions fail against the current minimal editor.

- [ ] **Step 3: Implement the editor**

Replace the whole contents of `src/components/site/ComparisonTariffEditor.tsx` with:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { ComparisonPlan, ComparisonVersion } from '@/lib/roi/comparison-tariff-repo';

type CreateForm = { name: string; buy_rate: string; sell_rate: string; effective_from: string };
const EMPTY: CreateForm = { name: '', buy_rate: '', sell_rate: '', effective_from: '' };

export function ComparisonTariffEditor({ siteId, plans, meteredPlanName }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const base = `/api/site/${siteId}/comparison-tariff`;

    // create form (intent depends on `addVersionFor`: a plan name => append-version, else create)
    const [form, setForm] = useState<CreateForm>(EMPTY);
    const [addVersionFor, setAddVersionFor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const set = (k: keyof CreateForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    // inline edit state: keyed by `${plan}@${version}`
    const [editing, setEditing] = useState<string | null>(null);
    const [editForm, setEditForm] = useState({ buy_rate: '', sell_rate: '', effective_from: '' });

    async function send(method: string, body: unknown, okMsg: string) {
        setBusy(true);
        try {
            const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 409 || res.status === 400) { const j = await res.json(); throw new Error(j.error); }
            if (!res.ok) throw new Error('request failed');
            toast({ title: 'Saved', description: okMsg, variant: 'success' });
            router.refresh();
            return true;
        } catch (e) {
            toast({ title: 'Error', description: e instanceof Error ? e.message : 'Could not save.', variant: 'danger' });
            return false;
        } finally { setBusy(false); }
    }

    async function saveCreate() {
        const intent = addVersionFor ? 'append-version' : 'create';
        const name = addVersionFor ?? form.name;
        const ok = await send('POST', { intent, name, buy_rate: form.buy_rate, sell_rate: form.sell_rate, effective_from: form.effective_from }, 'Comparison plan updated.');
        if (ok) { setForm(EMPTY); setAddVersionFor(null); }
    }

    function beginEdit(plan: string, v: ComparisonVersion) {
        setEditing(`${plan}@${v.version}`);
        setEditForm({ buy_rate: String(v.buy_rate), sell_rate: String(v.sell_rate), effective_from: v.effective_from ?? '' });
    }
    async function saveEdit(plan: string, version: number) {
        const ok = await send('PATCH', {
            name: plan, version,
            buy_rate: editForm.buy_rate, sell_rate: editForm.sell_rate,
            effective_from: editForm.effective_from || null,
        }, 'Version updated.');
        if (ok) setEditing(null);
    }

    return (
        <Card>
            <CardHeader><CardTitle>Comparison plans</CardTitle>
                <CardDescription>Baselines the savings grid prices against, date-resolved over your history. Your metered plan ({meteredPlanName}) is managed under Tariff Information.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {plans.map(plan => (
                    <div key={plan.name} className="rounded-lg border border-gray-200 dark:border-slate-800 p-3">
                        <div className="flex items-center gap-2">
                            <div className="font-medium">{plan.name}</div>
                            <button type="button" tabIndex={0} disabled={busy}
                                onClick={() => send('DELETE', { name: plan.name }, 'Plan deleted.')}
                                className="ml-auto text-xs text-red-600 dark:text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">
                                Delete plan
                            </button>
                        </div>
                        <div className="mt-2 space-y-2 text-sm">
                            {plan.versions.map(v => {
                                const key = `${plan.name}@${v.version}`;
                                if (editing === key) {
                                    return (
                                        <form key={v.version} onSubmit={(e) => { e.preventDefault(); saveEdit(plan.name, v.version); }}
                                            className="grid grid-cols-2 gap-2 rounded-md bg-bg-muted/40 p-2">
                                            <div className="flex flex-col gap-1"><Label>Buy $/kWh</Label><Input type="number" step="0.00001" value={editForm.buy_rate} onChange={(e) => setEditForm({ ...editForm, buy_rate: e.target.value })} /></div>
                                            <div className="flex flex-col gap-1"><Label>Sell $/kWh</Label><Input type="number" step="0.00001" value={editForm.sell_rate} onChange={(e) => setEditForm({ ...editForm, sell_rate: e.target.value })} /></div>
                                            <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={editForm.effective_from} onChange={(e) => setEditForm({ ...editForm, effective_from: e.target.value })} /></div>
                                            <div className="flex items-end gap-2">
                                                <Button type="submit" disabled={busy}>Save</Button>
                                                <button type="button" tabIndex={0} onClick={() => setEditing(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                                            </div>
                                        </form>
                                    );
                                }
                                return (
                                    <div key={v.version} className="flex items-center gap-3">
                                        <span className="font-mono">${v.buy_rate.toFixed(5)} / kWh</span>
                                        <span className="text-gray-500 dark:text-gray-400">{v.effective_from ?? 'undated'}{v.is_current ? ' · current' : ''}</span>
                                        <span className="ml-auto flex gap-2">
                                            <button type="button" tabIndex={0} onClick={() => beginEdit(plan.name, v)} className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">Edit</button>
                                            <button type="button" tabIndex={0} disabled={busy} onClick={() => send('DELETE', { name: plan.name, version: v.version }, 'Version deleted.')} className="text-xs text-red-600 dark:text-red-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">Delete</button>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        <button type="button" tabIndex={0}
                            onClick={() => { setAddVersionFor(plan.name); setForm(EMPTY); }}
                            className="mt-2 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1">
                            + add version
                        </button>
                    </div>
                ))}

                <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 p-3 space-y-3">
                    <div className="text-sm font-medium">
                        {addVersionFor ? `Add version to ${addVersionFor}` : 'Add comparison plan'}
                    </div>
                    <form onSubmit={(e) => { e.preventDefault(); saveCreate(); }} className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            {!addVersionFor && (
                                <div className="flex flex-col gap-1"><Label>Plan name</Label><Input value={form.name} onChange={set('name')} /></div>
                            )}
                            <div className="flex flex-col gap-1"><Label>Effective from</Label><Input type="date" value={form.effective_from} onChange={set('effective_from')} /></div>
                            <div className="flex flex-col gap-1"><Label>Buy rate $/kWh</Label><Input type="number" step="0.00001" value={form.buy_rate} onChange={set('buy_rate')} /></div>
                            <div className="flex flex-col gap-1"><Label>Sell rate $/kWh</Label><Input type="number" step="0.00001" value={form.sell_rate} onChange={set('sell_rate')} /></div>
                        </div>
                        <div className="flex gap-2">
                            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</Button>
                            {addVersionFor && (
                                <button type="button" tabIndex={0} onClick={() => { setAddVersionFor(null); setForm(EMPTY); }} className="text-xs text-gray-500 hover:underline">Cancel</button>
                            )}
                        </div>
                    </form>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        Custom TOU comparison plans are coming soon. For now, comparison plans are flat (Fixed) rates.
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/ComparisonTariffEditor.tsx cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx
git commit -m "feat(savings): comparison-plan manager — edit/delete versions, delete plan, add version"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `cd cmd/next-app && npm test`
Expected: all pass — including the new `comparison-tariff-repo`, `comparison-tariff/route`, and `ComparisonTariffEditor` cases.

- [ ] **Step 2: Build + lint + typecheck**

Run: `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 3: Confirm the `reporting_only` guard is everywhere it must be**

Run: `cd cmd/next-app && grep -n "reporting_only" src/lib/roi/comparison-tariff-repo.ts`
Expected: every `DELETE FROM "Tariff"` and the editing `UPDATE "Tariff"` carry `reporting_only` in their `WHERE` — the metered lineage can never be deleted/edited through this path.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(savings): Phase D manager-CRUD green" || echo "nothing to commit"
```

---

## Self-review notes (for the implementer)

- **Safety invariant — `reporting_only` everywhere.** Because `EnergyData.tariff_id → Tariff` is `ON DELETE CASCADE`, a `DELETE FROM "Tariff"` without the `reporting_only` guard on a metered tariff would cascade-wipe energy history. Every delete/edit statement in this plan carries the guard; Task 6 Step 3 verifies it. Do not "simplify" the guard away.
- **Current-version promotion.** Deleting a multi-version plan's current version must promote another version, or the plan loses its `is_current` row. The promote orders `effective_from DESC NULLS LAST, version DESC` — same ordering `listFixedComparisons` uses — so the newest remaining version becomes current. Deleting the *last* version leaves nothing to promote (the `UPDATE … WHERE id = (SELECT … LIMIT 1)` no-ops on an empty subselect), which is correct: the plan is gone.
- **Create-vs-append intent.** `appendFixedComparison` already creates version 1 or appends version N by `MAX(version)+1`, so the DB write is identical; `intent` only gates validation. `create` rejects an existing comparison name (you meant a new plan); `append-version` (sent by the per-plan "+ add version" button, name locked) skips that check. The metered-name check always runs.
- **Fixed-only is expected.** Editing a version updates the season + schedule rate pair that the flat-chain builder mints. TOU comparison plans (multi-window) don't exist yet — that's the deferred clone-and-tweak phase. A future TOU editor will need per-window edits, not this single-rate form; this plan deliberately does not generalize ahead of that.
- **Deferred from this slice:** clone-and-tweak TOU authoring, historical metered entry (`+ add past version` on the metered lineage), and plan **rename**. Each is its own follow-on; none is required for this manager to ship working software.
- **No `page.tsx` change.** The page already loads `comparisonPlans` via `listFixedComparisons` and passes them (plus `meteredPlanName`) into `SavingsSettings → ComparisonTariffEditor`. The new CRUD reuses that existing data flow; only the editor's interactivity grows.
- **Component test scope.** Under `environment: 'node'` there is no RTL, so the test asserts the controls *render* (Edit/Delete/add version present, stale note gone) via `renderToStaticMarkup` with `useRouter`/`useToast` mocked. Click-through behavior (fetch calls) is covered indirectly by the route tests; do not add jsdom just for this.
