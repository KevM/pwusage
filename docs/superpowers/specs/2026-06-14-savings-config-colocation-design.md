# Savings Config Co-location & Rollup Status — Design

**Date:** 2026-06-14
**Branch:** feat/roi
**Status:** Approved

## Problem

Two pieces of savings UX are split from where they belong:

1. **Config lives in the wrong tab.** `RoiConfigForm` (solar/battery net cost + install dates) and
   `ComparisonTariffEditor` (flat/TOU comparison plans) render in the **Settings** tab
   (`SettingsView.tsx`), separated from the **Savings** tab that consumes their output. A user
   landing on Savings with nothing configured sees an empty prompt that tells them to leave for the
   Settings tab.

2. **Rollup status fills in but never updates.** When a historical rollup (backfill) is in process,
   `IndexingStatus` shows a progress card, but the page only advances on a manual reload.

## Goals

- Co-locate all savings-related configuration on the Savings tab.
- Lead with configuration when nothing is set up yet; tuck it away once the user has savings to look
  at.
- Keep the in-process rollup as a full-screen takeover, but let progress advance and the view fill in
  automatically (~10 min refresh).

## Non-goals

- No changes to ROI math, comparison-tariff logic, or backfill mechanics.
- No changes to the backfill cron cadence (runs via Supabase pg_cron).
- The `RoiConfigForm` and `ComparisonTariffEditor` form internals are unchanged.

## Approach

Introduce a small client component, `SavingsSettings`, that wraps the two existing forms in a
disclosure. `SavingsView` (which stays a server component) renders it in the right place per state.
This isolates the new collapse/empty-state behavior in one focused unit and leaves the forms
untouched.

*Alternative considered:* inline the disclosure logic into `SavingsView` directly. Rejected because
`SavingsView` would have to become a client component, losing its server-rendered slot composition.

## Components

### 1. `SavingsSettings` (new, client)

`cmd/next-app/src/components/site/savings/SavingsSettings.tsx`

- Props: `siteId: string`, `roiConfig: SiteRoiConfig | null`, `comparisonPlans: ComparisonPlan[]`,
  `meteredPlanName: string`, `defaultOpen: boolean`.
- Renders a header toggle labeled "⚙️ Savings settings". Local `open` state initialized from
  `defaultOpen`.
- When open, stacks `RoiConfigForm` and `ComparisonTariffEditor` (reused as-is).

### 2. `SavingsView` (modified)

`cmd/next-app/src/components/site/savings/SavingsView.tsx`

Gains props `roiConfig` and `comparisonPlans`. Selects among three states:

- **Indexing in process** (`backfill.status` is `pending` or `running`): full-screen takeover —
  render `IndexingStatus` only. Unchanged except `IndexingStatus` now self-refreshes.
- **Not configured** (`summary == null`, not indexing): lead with `SavingsSettings` expanded
  (`defaultOpen=true`); also render the `IndexingStatus` "Index history" prompt when no backfill
  exists yet. `SavingsEmptyState` is removed — the inline config replaces its "go to Settings →"
  message.
- **Configured** (`summary != null`, not indexing): render savings output first (PaybackHero,
  recommendation note, ScenarioMatrix, fixed-plan note, chart, component cards, arbitrage), then
  `SavingsSettings` collapsed (`defaultOpen=false`) at the bottom. The existing incomplete-backfill
  banner (`showBackfillPrompt`) stays above the output.

### 3. `IndexingStatus` (modified)

`cmd/next-app/src/components/site/savings/IndexingStatus.tsx`

- While `backfill.status` is `pending`/`running`, a `useEffect` registers a 10-minute `setInterval`
  that calls `router.refresh()`, cleared on unmount/status change.
- Visual presentation of the progress card is unchanged.

### 4. `SettingsView` (modified)

`cmd/next-app/src/components/site/SettingsView.tsx`

- Remove `<RoiConfigForm>` and `<ComparisonTariffEditor>` renders and their imports.
- Remove the now-unused `roiConfig` and `comparisonPlans` props from `SettingsViewProps` and the
  destructure.

### 5. `page.tsx` (modified)

`cmd/next-app/src/app/site/[id]/page.tsx`

- Pass `roiConfig` and `comparisonPlans` to `<SavingsView>`.
- Drop `roiConfig`/`comparisonPlans` from `<SettingsView>`.
- Both values are already fetched server-side; no new queries.

### 6. `SavingsEmptyState` (removed)

`cmd/next-app/src/components/site/savings/SavingsEmptyState.tsx` is deleted; its only consumer is
`SavingsView`.

## State selection summary

| Condition | Render |
|---|---|
| backfill pending/running | `IndexingStatus` only (takeover, self-refresh) |
| summary null, not indexing | `SavingsSettings` (open) + index-history prompt if no backfill |
| summary present, not indexing | savings output + `SavingsSettings` (collapsed) |

## Testing

- `SavingsView`: state-selection tests — indexing → takeover; unconfigured → settings expanded;
  configured → savings output present + settings collapsed.
- `SavingsSettings`: toggle expands/collapses; `defaultOpen` honored.
- `IndexingStatus`: with fake timers, `router.refresh()` fires on the 10-minute interval while
  running and the interval is cleared on unmount.
- Run `npm run lint` and `npm run build` to confirm the removed `SettingsView` props and deleted
  `SavingsEmptyState` leave no dangling references.
