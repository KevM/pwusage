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

3. **The start button reappears mid-index.** The UI treats only `pending`/`running` as "in
   progress." A backfill that hits a recoverable error flips to `status === 'error'` while still
   being an in-flight job — the cron's `claimNext` automatically reclaims `error` rows (after 1h, up
   to 5 attempts; see `rollup-backfill-repo.ts`). During that window `IndexingStatus` falls through
   to its default branch and renders the "Index history" *start* button. Given the recent run of
   Tesla 529 "overload" errors, the `error` state is hit often, so the button reappears
   intermittently mid-index. (The POST handler already routes `error` → `retry()` preserving the
   cursor, so clicking is not destructive — but the button is wrong UX.)

## Goals

- Co-locate all savings-related configuration on the Savings tab.
- Lead with configuration when nothing is set up yet; tuck it away once the user has savings to look
  at.
- Keep the in-process rollup as a full-screen takeover, but let progress advance and the view fill in
  automatically (~10 min refresh).
- Treat a backfill that is in an `error` state as still in process (it auto-retries), not as
  "not started." Only offer the "Index history" *start* CTA when no backfill row exists.

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

Gains props `roiConfig` and `comparisonPlans`. The "in process" predicate is widened to include the
`error` state, since an `error` backfill is still an auto-retrying in-flight job:

```ts
const inProcess = backfill != null && backfill.status !== 'complete';
```

States:

- **Indexing in process** (`inProcess`, i.e. `pending` | `running` | `error`): full-screen takeover —
  render `IndexingStatus` only, now self-refreshing.
- **Not configured** (`summary == null`, not in process): lead with `SavingsSettings` expanded
  (`defaultOpen=true`); also render the `IndexingStatus` "Index history" start prompt when no
  backfill row exists yet. `SavingsEmptyState` is removed — the inline config replaces its "go to
  Settings →" message.
- **Configured** (`summary != null`, not in process): render savings output first (PaybackHero,
  recommendation note, ScenarioMatrix, fixed-plan note, chart, component cards, arbitrage), then
  `SavingsSettings` collapsed (`defaultOpen=false`) at the bottom. The existing incomplete-backfill
  banner (`showBackfillPrompt`) stays above the output.

### 3. `IndexingStatus` (modified)

`cmd/next-app/src/components/site/savings/IndexingStatus.tsx`

- Render branches keyed off status (no action buttons in any error branch):
  - `pending` | `running`: progress card (unchanged).
  - `error`, non-terminal (`last_error` not `[attempts=5]…`): "in process" card — progress bar at
    last cursor plus a "Paused — will retry automatically" note.
  - `error`, terminal (`last_error` starts with `[attempts=5]`, which the cron no longer reclaims):
    "Reconstruction paused — it will resume later" message, **no button** (avoids users hammering a
    failing Tesla API).
  - no backfill row (`null`): the "Index history" start CTA (unchanged).
  - The bug fix: the start CTA is reachable **only** when `backfill == null`, never for `error`.
- While the backfill is in process (`pending` | `running` | `error`), a `useEffect` registers a
  10-minute `setInterval` calling `router.refresh()`, cleared on unmount/status change.

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
| backfill pending / running / error | `IndexingStatus` only (takeover, self-refresh); error shows "paused, retrying" (terminal: "paused, will resume later", no button) |
| summary null, not in process | `SavingsSettings` (open) + index-history start CTA if `backfill == null` |
| summary present, not in process | savings output + `SavingsSettings` (collapsed) |

## Testing

- `SavingsView`: state-selection tests — pending/running/**error** → takeover; unconfigured (no
  backfill) → settings expanded + start CTA; configured → savings output present + settings collapsed.
- `SavingsSettings`: toggle expands/collapses; `defaultOpen` honored.
- `IndexingStatus`: **start CTA renders only when `backfill == null`**; non-terminal `error` renders
  the paused/retrying card (not the start button); terminal `[attempts=5]` error renders the
  "paused, will resume later" message with no button. With fake timers, `router.refresh()` fires on
  the 10-minute interval while in process and the interval is cleared on unmount.
- Run `npm run lint` and `npm run build` to confirm the removed `SettingsView` props and deleted
  `SavingsEmptyState` leave no dangling references.
