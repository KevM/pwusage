# Clone-from-Metered Seed — Implementation Plan (next-session handoff)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the comparison-plan Schedule Editor seed a new plan by **cloning the user's real metered tariff** — the most useful clone source ("compare against a tweaked version of my actual TOU plan"). This finishes the clone feature deferred from Phase B.

**Architecture:** The editor already supports clone-from-comparison-version via `onClone(key)` → `GET /comparison-tariff?name=&version=` (and `getPlanStructure` reads **any** tariff, metered or comparison — no `reporting_only` guard on reads). The only thing missing is the **metered plan's version number**: the loaded `Tariff` type doesn't carry `version`, so the manager can't build a `name@version` clone key for it. Phase B deferred this for exactly that reason. This plan (1) surfaces `version` on the loaded metered `Tariff`, then (2) threads `meteredPlanVersion` to `ComparisonTariffEditor` and adds the metered clone source. No new repo/route methods — the `GET` already serves metered structures.

**Tech Stack:** Next.js (App Router) Server Component (`page.tsx`), TypeScript, `pg` Pool, Vitest. Repo tests mock `./db` (`queryMock`); component path is unchanged.

---

## SESSION STATE (read first)

**Branch:** `feat/roi` — pushed to origin at `252607d` (clean working tree apart from `.claude/settings.local.json`, which is local-only — do not commit it).

**Shipped & verified this track (all on `feat/roi`):**
- **Flexible Comparison Matrix** — Phases B (hourly profile), C1 (pricing engine), C2 (on-read provenance), D (N-column grid), D (plan-manager-CRUD). All landed.
- **Schedule Editor Phase A (structures)** — `tou-coverage.ts`, `comparison-tariff-repo` structure methods (`getPlanStructure`, `saveComparisonStructure`, `listComparisonStructures`, `renameComparisonPlan`, kind-aware `listFixedComparisons`), structure-based route (`GET`/`POST`/`PATCH`/`DELETE` over `seasons[]` with server coverage check), date-resolved grid pricing (`comparisonStructTimeline`). Commits `cfef028`, `3c95ce5`.
- **Schedule Editor Phase B (UI)** — `ScheduleEditor.tsx` (route-agnostic: injected `onSave`/`onClone`, owns no HTTP), manager rewire in `ComparisonTariffEditor.tsx` (create / edit / add-version / rename / Fixed-TOU badge), `scheduleHasGaps`. Commits `7ee4299`, `e713b6e`, `252607d`. Reviewed & green (612 tests, tsc, lint).

**Key constraint to respect:** `ScheduleEditor` must stay route-agnostic (no `fetch`, no comparison-vs-metered logic) so it can later be reused for **historical metered-tariff entry**. See memory `project_schedule_editor_modular`. This plan touches only the *caller* (`ComparisonTariffEditor`) and the data loader — **do not** add metered logic inside `ScheduleEditor`.

**Remaining backlog after this plan** (each its own future plan): historical metered-tariff entry (the big ScheduleEditor reuse); re-point payback summary at a date-resolved baseline (`resolve-fixed-baseline.ts` is still Fixed-only); sub-hour TOU windows (engine limitation).

---

## Key facts grounding this plan (verified against the code)

- **`Tariff` has no `version` field** ([db.ts](../../cmd/next-app/src/lib/db.ts) — `interface Tariff { id, site_id, updated, name, reporting_only?, effective_from?, seasons? }`). The metered loader never selects it.
- **The metered loader** is `SiteRepo.loadSitesFromDB` ([site-repo.ts:111](../../cmd/next-app/src/lib/site-repo.ts)): `LEFT JOIN "Tariff" t … AND t.is_current AND NOT t.reporting_only`, assembled in `assembleFromRows` ([site-repo.ts:155](../../cmd/next-app/src/lib/site-repo.ts)). Add `t.version` to the SELECT and map it.
- **`getPlanStructure` reads any tariff** ([comparison-tariff-repo.ts:148](../../cmd/next-app/src/lib/roi/comparison-tariff-repo.ts)) — `WHERE t.site_id = $1 AND t.name = $2 AND t.version = $3` with **no** `reporting_only` guard, so the metered plan is a valid clone source. The route `GET` ([route.ts:30](../../cmd/next-app/src/app/api/site/[id]/comparison-tariff/route.ts)) requires `name` + integer `version`.
- **Editor clone contract** ([ScheduleEditor.tsx:107](../../cmd/next-app/src/components/site/ScheduleEditor.tsx)): renders a `<select>` of `cloneSources: { label, key }[]` when `onClone && cloneSources.length > 0`; on pick calls `onClone(key)`. The manager's `onClone` ([ComparisonTariffEditor.tsx:49](../../cmd/next-app/src/components/site/ComparisonTariffEditor.tsx)) splits `key` on the last `@` into `name`/`version` and `GET`s the structure. So a metered clone source just needs `key = "<meteredName>@<meteredVersion>"`.
- **Prop path:** `page.tsx` ([site/[id]/page.tsx:396](../../cmd/next-app/src/app/site/[id]/page.tsx)) → `SavingsView` ([SavingsView.tsx:22](../../cmd/next-app/src/components/site/savings/SavingsView.tsx)) → `SavingsSettings` ([SavingsSettings.tsx:38](../../cmd/next-app/src/components/site/savings/SavingsSettings.tsx)) → `ComparisonTariffEditor`. `meteredPlanName` already flows this path; add `meteredPlanVersion` alongside it. The current metered tariff is `finalSite.tariffs?.[0]`.
- **Site-repo test pattern** ([site-repo.test.ts](../../cmd/next-app/src/lib/site-repo.test.ts)): `vi.mock('./db', …)` with `queryMock`; `makeSiteJoinRow(overrides)` builds a join row (defaults all `tariff_*`/`season_*` to null); assert on `repo.getSite('site-1')`. Remember `repo.invalidateCache('site-1')` (the suite does this in `beforeEach`).

---

## File Structure

**Modify:**
- `cmd/next-app/src/lib/db.ts` — add `version?: number` to `interface Tariff`.
- `cmd/next-app/src/lib/site-repo.ts` — select `t.version AS tariff_version`; map it in `assembleFromRows`.
- `cmd/next-app/src/lib/site-repo.test.ts` — assert the loaded metered tariff carries `version`; add `tariff_version: null` to `makeSiteJoinRow` defaults.
- `cmd/next-app/src/app/site/[id]/page.tsx` — pass `meteredPlanVersion={finalSite.tariffs?.[0]?.version ?? null}` into `SavingsView`.
- `cmd/next-app/src/components/site/savings/SavingsView.tsx` — accept + forward `meteredPlanVersion`.
- `cmd/next-app/src/components/site/savings/SavingsSettings.tsx` — accept + forward `meteredPlanVersion`.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.tsx` — accept `meteredPlanVersion`; prepend a metered clone source.
- `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx` — assert the metered clone option renders.

**Untouched (explicitly):** `ScheduleEditor.tsx` (route-agnostic — no changes), `comparison-tariff-repo.ts`, `route.ts` (the `GET` already serves metered structures).

---

## Task 1: Surface `version` on the loaded metered `Tariff`

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts`, `cmd/next-app/src/lib/site-repo.ts`
- Test: `cmd/next-app/src/lib/site-repo.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/site-repo.test.ts`, add `tariff_version: null` to the `makeSiteJoinRow` defaults (next to `tariff_name: null`). Then add this test inside the existing top-level `describe`:

```ts
it('exposes the metered tariff version on the loaded site', async () => {
    queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({
        tariff_id: 7, tariff_name: 'Standard', tariff_updated: new Date('2026-01-01T00:00:00Z'),
        tariff_site_id: 'site-1', tariff_reporting_only: false, tariff_effective_from: '2025-01-01',
        tariff_version: 3,
    })] });
    const repo = new SiteRepo();
    repo.invalidateCache('site-1');
    const site = await repo.getSite('site-1');
    expect(site?.tariffs?.[0]?.version).toBe(3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/site-repo`
Expected: FAIL — `version` is `undefined` (not selected/mapped).

- [ ] **Step 3: Implement**

In `src/lib/db.ts`, add to `interface Tariff` (after `effective_from`):

```ts
  version?: number;                // current metered version; used as a clone seed key
```

In `src/lib/site-repo.ts`, add `t.version` to the tariff SELECT (next to `t.effective_from::text AS tariff_effective_from`):

```ts
                t.version     AS tariff_version,
```

In `assembleFromRows`, add to the `tariff` object literal (after `effective_from`):

```ts
                    version: row.tariff_version != null ? Number(row.tariff_version) : undefined,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/site-repo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/db.ts cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-repo.test.ts
git commit -m "feat(roi): surface metered Tariff.version for clone-from-metered seed"
```

---

## Task 2: Thread `meteredPlanVersion` and add the metered clone source

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/page.tsx`, `.../savings/SavingsView.tsx`, `.../savings/SavingsSettings.tsx`, `.../ComparisonTariffEditor.tsx`
- Test: `cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

In `src/components/site/ComparisonTariffEditor.test.tsx`, the editor only shows clone sources inside `ScheduleEditor` once "Add comparison plan" is clicked — which static render can't do. Instead assert the metered source is **wired**: extend the render helper to pass the new prop, then assert the manager accepts it without changing the list output, and add a focused unit assertion on the clone-key format by rendering the create editor directly is out of scope for node-env. Use this lighter contract test:

```tsx
it('accepts a meteredPlanVersion prop (clone-from-metered wiring)', () => {
    const html = renderToStaticMarkup(
        <ComparisonTariffEditor siteId="s1" plans={plans} meteredPlanName="Standard" meteredPlanVersion={3} />,
    );
    expect(html).toContain('EV Plan');            // still renders the list
    expect(html).toMatch(/add comparison plan/i); // entry point intact
});
```

> Note: the metered `<option>` only renders after the create editor is opened (a click), which node-env static render can't trigger; the wiring is covered by tsc + the prop assertion above. If a richer assertion is wanted later, switch this suite to jsdom — out of scope here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: FAIL — `meteredPlanVersion` is not a declared prop (type error / build fails).

- [ ] **Step 3: Implement**

`src/components/site/ComparisonTariffEditor.tsx` — add the prop and prepend the metered clone source:

```tsx
export function ComparisonTariffEditor({ siteId, plans, meteredPlanName, meteredPlanVersion }: {
    siteId: string; plans: ComparisonPlan[]; meteredPlanName: string; meteredPlanVersion?: number | null;
}) {
```

Replace the `cloneSources` definition with one that leads with the metered plan:

```tsx
    // clone seeds: the user's real metered plan first (most useful), then each comparison
    // plan's current version. key encodes name + version so onClone resolves it via GET.
    const cloneSources: CloneSource[] = [
        ...(meteredPlanVersion != null
            ? [{ label: `${meteredPlanName} (metered)`, key: `${meteredPlanName}@${meteredPlanVersion}` }]
            : []),
        ...plans.flatMap(p => p.versions.filter(v => v.is_current).map(v => ({ label: `${p.name} (current)`, key: `${p.name}@${v.version}` }))),
    ];
```

`src/components/site/savings/SavingsSettings.tsx` — add the prop and forward it:

```tsx
export function SavingsSettings({
  siteId, roiConfig, comparisonPlans, meteredPlanName, meteredPlanVersion, defaultOpen,
}: {
  siteId: string;
  roiConfig: SiteRoiConfig | null;
  comparisonPlans: ComparisonPlan[];
  meteredPlanName: string;
  meteredPlanVersion?: number | null;
  defaultOpen: boolean;
}) {
```
```tsx
          <ComparisonTariffEditor siteId={siteId} plans={comparisonPlans} meteredPlanName={meteredPlanName} meteredPlanVersion={meteredPlanVersion} />
```

`src/components/site/savings/SavingsView.tsx` — add the prop (after `meteredPlanName?: string;`) and forward it into `<SavingsSettings>`:

```tsx
    meteredPlanVersion,
```
```tsx
    meteredPlanVersion?: number | null;
```
```tsx
            meteredPlanName={meteredPlanName ?? 'Standard'}
            meteredPlanVersion={meteredPlanVersion}
```

`src/app/site/[id]/page.tsx` — pass the current metered version into `<SavingsView>` (alongside `meteredPlanName={finalSite.tariffs?.[0]?.name ?? 'Your plan'}`):

```tsx
                        meteredPlanVersion={finalSite.tariffs?.[0]?.version ?? null}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/site/ComparisonTariffEditor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/site/\[id\]/page.tsx cmd/next-app/src/components/site/savings/SavingsView.tsx cmd/next-app/src/components/site/savings/SavingsSettings.tsx cmd/next-app/src/components/site/ComparisonTariffEditor.tsx cmd/next-app/src/components/site/ComparisonTariffEditor.test.tsx
git commit -m "feat(savings): clone-from-metered — offer the metered plan as a Schedule Editor seed"
```

---

## Task 3: Final verification

- [ ] **Step 1:** `cd cmd/next-app && npm test` — all pass.
- [ ] **Step 2:** `cd cmd/next-app && npm run build && npm run lint && npx tsc --noEmit` — all pass.
- [ ] **Step 3: Confirm the editor stayed route-agnostic.** `cd cmd/next-app && grep -c "fetch" src/components/site/ScheduleEditor.tsx` → expected `0` (the reuse boundary held; metered clone lives entirely in the caller).
- [ ] **Step 4 (optional, live):** open the app, Savings settings → Add comparison plan → "Clone from" shows **`<metered name> (metered)`**; pick it → editor seeds with the metered structure → tweak a window rate → Save → the new plan appears and the grid prices it as a distinct column.
- [ ] **Step 5:** `git add -A && git commit -m "test(savings): clone-from-metered green" || echo "nothing to commit"`, then `git push origin feat/roi`.

---

## Self-review notes (for the implementer)

- **`getPlanStructure` reads metered tariffs by design** (no `reporting_only` guard on reads), so cloning the metered plan needs no new repo/route work — only its `version`, which Task 1 surfaces. Do not add a metered-specific read path.
- **Keep metered logic out of `ScheduleEditor`.** The clone source is just another `{ label, key }`; the editor never learns it's "metered." This preserves the reuse boundary for the future historical-metered-entry phase. (Memory: `project_schedule_editor_modular`.)
- **`version` is optional on `Tariff`** so comparison-structure rows (which don't select it) and existing callers are unaffected; only the metered loader populates it.
- **Clone is offered on create only** (the manager passes `cloneSources` solely for `intent === 'create'`). That's intentional and unchanged — metered clone is a from-scratch seed. Enabling it for append-version is a later nicety, not this plan.
