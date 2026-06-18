# Metered Plan History — Design

**Date:** 2026-06-18
**Branch:** `feat/roi`
**Status:** Approved (brainstorm) — ready for implementation plan

## Problem

The ROI/savings engine date-resolves the metered plan across its `Tariff` versions via `meteredTimeline(tariffs, tz)` ([plan-timeline.ts:62](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) → `scheduleTimeline` → `pickByDate`, which selects each version by `effective_from`. But **`effective_from` is only ever written for comparison plans** (the `comparison-tariff` route). Metered versions are created by the importer's `addTariffVersion` ([tariff-repo.ts:45](../../cmd/next-app/src/lib/tariff-repo.ts)), whose INSERT never sets `effective_from` — so **every metered version is null-dated**.

Consequences, given `pickByDate` carries the *earliest* version backward and `null` sorts as `0000-01-01` (earliest):
- A site whose Tesla rate plan changed during observation has **multiple null-dated versions**, all colliding at `0000-01-01`. The tie resolves by array order, so the whole history is priced under one ambiguously-chosen version — **silent mispricing**.
- There is no way to record a metered plan that was in effect **before** the app started observing (historic entry), so payback/savings for older energy can't price correctly.

Three connected gaps:
1. **Forward:** when the importer detects a tariff change and appends a version, it doesn't set `effective_from`.
2. **Existing data:** old Tesla-sourced versions already in the DB are all null-dated.
3. **Historic:** no way to introduce metered tariff versions that were effective in the past.

## Goal

Give metered `Tariff` versions correct effective dates so the ROI/savings `meteredTimeline` date-resolves them, and let the user correct those dates and author historic versions. One shared effective-date model and authoring surface serves all three gaps.

## Scope boundary

This feeds **ROI/savings date-resolution only** (`meteredTimeline` over the hourly profile, consumed by `buildRoiSummary`, `monthlyCumulative`, `computeArbitrage`, and the metered grid column).

The **bill view is explicitly untouched.** `energy-repo` deliberately prices with the *current* tariff (`new Schedule(site.tariffs, ...)` at [energy-repo.ts:162](../../cmd/next-app/src/lib/energy-repo.ts)); the snapshot `tariff_id` is used only for the name label (comment at [energy-repo.ts:142](../../cmd/next-app/src/lib/energy-repo.ts)). Historical date-resolved billing is a separate concern, out of scope.

## The invariant

Date-resolution is unambiguous as long as: **within a metered plan, at most one version has a null `effective_from`, and it must be the chronologically earliest.** `pickByDate` already carries that earliest version backward over all prior dates (no energy precedes the first version anyway). Part 2 establishes this invariant for existing data; Part 3's manager maintains it.

## Design

### Part 1 — Forward: importer sets `effective_from`

`addTariffVersion(siteId, parsed)` ([tariff-repo.ts:45](../../cmd/next-app/src/lib/tariff-repo.ts)) is called from [importer/index.ts:336](../../cmd/next-app/src/lib/importer/index.ts) **only when `tariff_content_v2` canonically changed**. Thread a detection date in and write it into the `Tariff` INSERT (which currently omits `effective_from`):

- New version appended because content changed → `effective_from =` site-local today (the detection date — our honest upper bound; Tesla's payload carries no real effective date, so this is the only signal).
- The **first** version for a site stays `null` (carry-back anchor; no energy precedes it).
- The `content_hash` idempotency guard is unchanged — `effective_from` never enters the hash, so re-syncs of unchanged content remain no-ops.

> The true rate-change date may precede detection (utility flips Sep 1; cron first sees it Sep 15). That lag is corrected by the Part 3 manual-edit surface — the same surface needed for historic entry.

### Part 2 — Backfill existing null-dated versions

One idempotent migration. Per site, over `reporting_only = false` tariffs ordered by `version` ascending:
- Leave the **earliest** version's `effective_from` as-is (null OK).
- Set every **later** version whose `effective_from` is null to its own `Tariff.updated::date` (the row's detection date).
- Comparison plans (`reporting_only = true`) are never touched — they own their dates.

Result: the one-null-earliest invariant holds for every existing site; multi-version metered sites stop mispricing.

### Part 3 — Dedicated "Metered plan history" manager

A new client component rendered in `SavingsSettings` ([savings/SavingsSettings.tsx](../../cmd/next-app/src/components/site/savings/SavingsSettings.tsx)), below `ComparisonTariffEditor`. Kept separate from the comparison-plan manager because metered versions have different ownership/safety: Tesla owns their content, they back the live bill, and `EnergyData` FK-references them.

Lists metered versions newest-first, each showing **effective date (editable)**, a rates summary, and a Fixed/TOU badge (`classifyTariff`). Two actions:

- **Edit a version's effective date** — date picker → PATCH. This corrects detection lag and is how the user "makes room" to prepend older history (set the earliest version's real start date so a historic version can sort before it).
- **Add a historic version** — opens the route-agnostic `ScheduleEditor` (reuse per memory `project_schedule_editor_modular`; injected `onSave`, owns no HTTP). Saved as a new metered `Tariff` version: `reporting_only = false`, monotonic `version = MAX+1`, **not** `is_current` (the current Tesla version stays current), user-chosen `effective_from`. The timeline resolves by date, not version number, so a logically-earlier version with a higher number prices correctly.

Synced versions' **rates are read-only** (Tesla owns them); only their effective date is editable. The earliest version renders as "from the beginning."

A new API route handles both writes — metered PATCH-date and POST-historic-version via `TariffRepo` with `reporting_only = false`, authorized by `verifySiteAccess`. It mirrors the comparison-tariff route's shape but never writes into Tesla-owned content semantics.

### Data flow

```
importer (content changed) ──addTariffVersion(effective_from = detection date)──┐
backfill migration (updated::date for later null versions) ─────────────────────┤
metered manager (PATCH date / POST historic version, reporting_only=false) ─────┤
                                                                                 ▼
                                              Tariff rows (effective_from per version)
                                                                                 │
                                          meteredTimeline(site.tariffs, tz)  (date-resolved)
                                                                                 │
                          ┌──────────────────┬─────────────────────┬────────────┘
                   buildRoiSummary    monthlyCumulative      computeArbitrage / grid metered column
```

## Data model

No schema change. `Tariff.effective_from` already exists (used today only by comparison plans). The only data write beyond runtime is the Part 2 backfill migration.

## Testing (TDD)

- **Importer** — `addTariffVersion` sets `effective_from` to the detection date on a content change; the first version stays null; a no-op re-sync (same `content_hash`) writes nothing.
- **Backfill migration** — a site with 3 null-dated metered versions ends with the earliest null and the later two dated from `updated`; idempotent on re-run; comparison plans untouched.
- **Engine regression** — a 2-version metered plan with distinct effective dates prices early energy at the old version and later energy at the new one through `meteredTimeline` (mirrors the payback-baseline guard at [roi-service.test.ts](../../cmd/next-app/src/lib/roi/roi-service.test.ts)). Single-version / single-null ⇒ unchanged.
- **API route** — PATCH updates one version's `effective_from`; POST creates a historic version (`reporting_only=false`, not `is_current`, `version = MAX+1`); authz via `verifySiteAccess`.
- **Manager component** — renders versions newest-first; synced rates read-only; date-edit and "add historic" wired to the route; earliest version shows "from the beginning."
- Full suite + `npm run build` + `npm run lint` + `npx tsc --noEmit` green.

## Out of scope (deferred)

- **Historical date-resolved bill view** — `energy-repo` stays current-rate. A future feature could date-resolve the bill from the same versioned metered tariffs.
- **Editing the rates of a Tesla-synced version** — Tesla owns synced content; only effective dates are editable. (Historic versions the user authors are fully editable as their own content.)
- **Inferring the true effective date from utility data** — Tesla's payload carries none; detection date + manual correction is the model.
- **Sub-hour TOU windows** — unrelated engine limitation, separate backlog item.
