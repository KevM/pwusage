# Schedule Editor — Unified Comparison-Plan Authoring — Design

**Date:** 2026-06-16
**Status:** Design approved (brainstorm), pending spec review
**Branch context:** `feat/roi`. Realizes the **clone-and-tweak TOU authoring** half that was deferred from the Phase D plan-manager-CRUD plan (`2026-06-16-flexible-matrix-phase-d-plan-manager-crud.md`), and is governed by decision 10 of the parent design (`2026-06-15-flexible-comparison-matrix-design.md`). The manager-CRUD slice (list + per-plan/per-version delete, Fixed create/edit) already shipped; this design **unifies** that Fixed-specific authoring into a single Schedule Editor. It also **supersedes** the parent design's "from-scratch TOU schedule authoring is out of scope" stance (decision 10 / Out of scope): once the editor is a full schedule editor, create-from-scratch is the same editor on a blank seed, so it is included rather than deferred.

## Problem

Comparison plans today can only be **Fixed** (one flat rate). The savings grid is built to price any plan date-resolved, and the pricing engine already handles full TOU structures — but there is **no UI to author a TOU comparison plan**. The parent design deferred this as "clone-and-tweak TOU authoring."

During brainstorming the framing sharpened: a Fixed plan and a TOU plan are not two different things to author. **A schedule is a schedule.** Fixed is simply the degenerate case — one season (all year) containing one window (all days, 00:00–24:00). So the app does not need a "Fixed form" and a separate "TOU editor"; it needs **one Schedule Editor** whose simplest state *is* a flat plan.

## Key decisions (from brainstorming)

1. **One Schedule Editor, not Fixed-vs-TOU modes.** Fixed = a schedule with a single 24/7 window in a single all-year season. TOU = the same editor once a second window or season exists. The "Fixed / TOU" label is **derived** (via the existing `classifyTariff`), never a stored type or an authoring fork.
2. **Full editing scope.** The user can edit window rates, window day/time ranges, add/remove windows, and add/remove/retime seasons. This is functionally a from-scratch editor; a clone is only a convenient starting seed.
3. **Two co-equal entry paths into one editor: create-from-scratch and clone.** "Create new" opens the editor on a blank seed — the degenerate single all-year / 24/7 window, itself a valid coverage-passing plan to shape. "Clone from \<source\>" fetches a metered or comparison version's parsed structure and pre-fills the editor instead. Both are client-side seeds; there is no server-side deep-copy path — the server only ever persists whatever full structure the editor submits. Create-from-scratch, clone, and tweak collapse into one write path.
4. **Coverage validation is load-bearing and uniform.** Because the user can reshape structure arbitrarily, the safety invariant is *coverage*: the whole year must be partitioned by seasons, and within each season every `(weekday, hour)` must resolve to a window. Validated client-side (drives the heatmap, blocks Save) **and** server-side (authoritative, rejects with 400). The degenerate flat plan passes trivially.
5. **Layout = form tables + live coverage heatmap** (Option C from brainstorming). Editing is form-based (matches the window data model and existing `TariffList` display); a read-only heatmap driven by the **real resolver** renders the 7×24 coverage per season and lights gaps red. The preview *is* the validator made visible.
6. **Unify the just-shipped Fixed path.** The dedicated flat create form, `appendFixedComparison`, and the rate-only `editComparisonVersion` are folded into the unified editor + a general `saveComparisonStructure`. `fixed-comparison.ts`'s flat builder survives only as the editor's initial seed state.
7. **No DB migration.** `Tariff → TariffSeason → TariffSchedule` already store arbitrary TOU structures (that is how metered tariffs are persisted) and `reporting_only` already exists. This is repo + route + UI only.
8. **The grid must price comparison columns from their real structure.** `comparisonPlanTimeline` currently builds a *flat* timeline from a single rate, so an authored TOU comparison plan would price at zero. It is generalized to build each comparison column via the existing `scheduleTimeline` over that plan's Tariff→Season→Schedule versions — exactly how `meteredTimeline` already works. Fixed and TOU comparison columns then price through one uniform path. Without this, authoring is non-functional, so it is in scope.

## Scope

**In scope:** a full Schedule Editor for **comparison plans** (`reporting_only` tariffs): create a new plan, edit an existing version in place, append a new effective-dated version — Fixed or TOU through the same editor, seeded optionally by cloning any metered or comparison version. Plus the grid integration (decision 8) so authored TOU columns price correctly, and a manager list that derives a Fixed/TOU badge.

**Out of scope (each a later plan):**
- **Historical metered entry** ("+ add past version" on the real metered lineage). Same clone-and-tweak mechanism, but it targets the *metered* `TariffRepo` lineage rather than `reporting_only` plans. Deferred.
- **Plan rename.** Touches the `(site_id, name)` indexes; deferred (per-version content editing covers the substance).
- **Sub-hour TOU windows.** The hourly pricing engine does not support them (parent design caveat).

## Architecture

```
Schedule Editor (client)
  seed ← GET structure (metered version | comparison version | blank flat)
  edit seasons[]/windows[] in form tables
  live heatmap ← tou-coverage.windowCoverage() over the in-progress structure
  Save (blocked while gaps exist)
        │  POST/PATCH full seasons[] payload
        ▼
Route: comparison-tariff/
  verifySiteAccess → server-side tou-coverage check (400 on gap)
        │
        ▼
ComparisonTariffRepo.saveComparisonStructure(intent: create|append-version|replace)
  persists reporting_only Tariff → Season(s) → Schedule(s), reporting_only-guarded
        │
        ▼
listFixedComparisons / pricing engine (unchanged) consume the result
```

### Resolution semantics this builds on (`lib/schedule.ts`)

The production resolver is **most-specific-window-wins**: it sorts a season's schedules by narrower day-range first, then time-specific before all-day, and returns the first match; an unmatched `(weekday, hour)` returns `null`. Consequences for the editor:

- **Overlaps are safe** — a Sat–Sun all-day off-peak window correctly overrides an "Every Day" peak window. We do **not** forbid overlaps.
- **Gaps are the only failure** — a `null` resolution is an unpriced hour, which would corrupt a plan's column. Coverage validation hunts exactly these.
- **The safe authoring pattern** (what every cloned plan already is): one **catch-all base window** (all days / all hours) per season guarantees coverage; specific peak windows layer on top. Coverage is only at risk if the user deletes the base window. The editor surfaces this through the heatmap rather than constraining edits.

## Components / files

**New:**
- **`src/lib/roi/tou-coverage.ts`** — pure, independently tested coverage unit:
  - `seasonCalendarGaps(seasons)` → days of a reference (leap) year matched by zero or by >1 season.
  - `windowCoverage(season)` → the 7×24 grid of resolved/unresolved cells + the gap list, computed via the same resolution semantics as `lib/schedule.ts`.
  Shared by the client heatmap and the server-side validation so "valid" means the same thing in both.
- **`src/components/site/ScheduleEditor.tsx`** (`'use client'`) — the form-tables + heatmap editor. Renders seasons (date-range fields + window table) with add/remove for windows and seasons, an entry chooser (**Create from scratch** → blank single-window seed, or **Clone from** a metered/comparison version), and the live coverage heatmap. Save disabled while any gap exists.

**Modified:**
- **`src/lib/roi/comparison-tariff-repo.ts`** — add `getPlanStructure(siteId, name, version)` (full parsed seasons/schedules for seeding + editing — reads **any** of the site's tariffs, metered or comparison, since the metered plan is a valid clone seed; reads need no `reporting_only` guard) and `saveComparisonStructure(siteId, name, effectiveFrom, seasons, intent)` (create / append-version / replace-in-place), all `reporting_only`-guarded, reusing the transactional insert pattern of the current `appendFixedComparison`. Retire `appendFixedComparison` and the rate-only `editComparisonVersion` once the editor uses the general path (`deleteComparisonVersion`, `deleteComparisonPlan`, `comparisonNameInUse`, `nameInUseByMetered` are reused unchanged). The plan listing (`listFixedComparisons`) is extended to carry enough per version to derive a Fixed/TOU **kind** (e.g. window count) so the manager can badge each plan — Fixed shows its flat rate, TOU shows the badge — and to feed the grid (below).
- **`src/lib/roi/plan-timeline.ts`** — generalize `comparisonPlanTimeline` to build a date-resolved timeline from a comparison plan's full Tariff→Season→Schedule versions via the existing `scheduleTimeline`, instead of the flat single-rate path. The flat `ComparisonPlan.buy_rate/sell_rate` is no longer the pricing source; Fixed prices as the degenerate one-window schedule.
- **`src/app/site/[id]/page.tsx`** — load comparison plans' full structures (grouped by name) server-side and build each grid column via the generalized `comparisonPlanTimeline` so TOU columns price date-resolved. (`finalSite.tariffs` already supplies the metered structure.)
- **`src/app/api/site/[id]/comparison-tariff/route.ts`** — add `GET` (return a version's structure); extend `POST` (create / append-version) and `PATCH` (replace) to accept a full `seasons[]` payload and run the server-side coverage check (400 on gap). The metered-name and create-vs-append-intent guards from the manager-CRUD phase are preserved.
- **`src/components/site/ComparisonTariffEditor.tsx`** — replace the flat create form and rate-only inline edit with entry points into `ScheduleEditor` (Add plan; per-version Edit; per-plan + add version), plus the derived Fixed/TOU badge. The list/delete affordances already shipped stay.
- **`src/lib/roi/fixed-comparison.ts`** — repurposed as "seed a single 24/7 all-year window"; the editor's blank-flat starting state.

## Data flow — seeding the editor

Create-from-scratch needs no fetch (the blank single-window seed is built client-side). Clone fetches one source's structure on demand. The list stays lightweight (names, versions, effective dates, derived Fixed/TOU badge). The editor fetches full structure **on demand** for exactly the one plan being edited or used as a seed, via `GET`. This avoids passing every plan's full season/schedule tree into the page just to render a manager list. The metered structure is already available server-side (`finalSite.tariffs`) and is offered as a seed source.

## Edit semantics (mirrors the shipped manager)

- **Edit a version** → `PATCH` intent `replace`: replace that version's season/schedule chain in place.
- **+ add version** → `POST` intent `append-version`: append a new effective-dated version; current-version promotion is the existing repo behavior.
- **Delete version / delete plan** → already shipped; structure-agnostic, unchanged for TOU.

## Testing strategy

- **Coverage unit (`tou-coverage`):** a full-week/full-year plan reports no gaps; a deleted base window reports the uncovered hours; a season-calendar gap and a double-covered day are both detected; a midnight-crossing window (e.g. 21→6) covers correctly; a Sat–Sun all-day window overriding an "Every Day" peak window resolves with no false gap.
- **Repo:** `saveComparisonStructure` persists a multi-season/multi-window chain and is `reporting_only`-guarded for create / append-version / replace; `getPlanStructure` returns the full parsed tree; a degenerate one-window save round-trips as a Fixed plan.
- **Route:** `GET` returns structure; `POST`/`PATCH` happy paths persist; **a payload with a coverage gap is rejected 400**; metered-name collision still 409.
- **Grid pricing:** a TOU comparison plan prices peak/off-peak energy at the correct per-window rates in the extended grid (regression: a Fixed comparison plan still equals energy-total × flat rate after the generalization).
- **Component:** the editor renders seasons + window rows; the heatmap lights a seeded gap red; Save is disabled while a gap exists; the degenerate single-window state renders as an all-green flat plan; the manager list badges Fixed vs TOU.

## Caveats

- **Hour-aligned windows only** — inherited from the pricing engine; sub-hour windows unsupported.
- **Day-of-week convention** — windows store Tesla's `0=Mon … 6=Sun`; the editor presents human day labels and maps on read/write (the same convention `TariffList` and `lib/schedule.ts` already use).
- **Touches recently-shipped code** — the Fixed-specific create/edit path from the manager-CRUD phase is intentionally refactored into the unified path (decision 6); its tests are updated accordingly.
- **ROI-summary fixed baseline is unchanged and stays Fixed-oriented** — `pickCurrentFixedBaseline` / `resolve-fixed-baseline.ts` feed the payback summary from a flat rate and are **out of scope** here. They keep reading the flat `ComparisonPlan` rate, so they only pick a meaningful baseline from a Fixed comparison plan; a TOU plan contributes no flat baseline. Re-pointing the payback summary at a date-resolved baseline is a separate follow-on. This design changes only the **extended-grid** column pricing (decision 8), not the payback summary.
