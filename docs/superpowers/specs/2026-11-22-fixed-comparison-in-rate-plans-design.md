# Fixed comparison plans in the rate plan UX — design

Date: 2026-11-22 · Status: draft for review · Apps: iOS (`cmd/ios-app`) + web API (`cmd/next-app`)

## Why

Savings compare what you paid against a **fixed comparison plan** (the term from
`docs/voice-and-terms.md`; code calls it the reference plan). It prices three of the four savings
figures — No Solar, Solar only and Solar + Powerwall on a fixed plan — so it has to be right for
every date, including the dates of each historic rate plan.

The data model already supports that: `TariffReferencePeriod` holds dated fixed plans, the server
fills it from the utility's standard plan revisions (`estimated_reference`, up to 80 revisions), and
`SavingsCalculator` prices each 5-minute slot on whichever reference period covers it.

The UX hides it:

- No screen lists fixed comparison plans. The Bill and Solar System savings cards open
  `FixedRatePlanForm` on the single plan active today (`activeReferencePeriod`); the savings caveat
  opens the earliest one. A site with a dozen revisions shows one.
- The form is a standalone "Add Fixed Rate Plan" entry with a start date only, disconnected from the
  rate plans it is compared against. This confused the owner when debugging Demo mode
  (Bill → Add Fixed Rate Plan).
- Find My Rate Plans (`RatePlanHistoryFlow`) records which plans you were actually on, but never
  shows or asks about the fixed comparison for them. `PUT utility/history` writes only the actual
  timeline.

## Goals

1. Each historic rate plan shows its fixed comparison plan directly beneath it, in both the guide's
   review and the rate plan editor, prefilled and changeable in place.
2. Find My Rate Plans saves your plans and their fixed comparisons in one all-or-nothing save.
3. The fixed comparison is reached through the rate plan UX; the standalone entry points go away.

## Non-goals

- Changing savings math, the reference resolver or how `estimated_reference` revisions are built.
- The savings card redesign (cost table of No Solar / Solar only / Solar + Powerwall × fixed /
  your plan). Agreed as the next, separate project.
- Web UI. The web app has no fixed comparison UI today and gets none here; only its API changes.
- Asking a question per plan in the guide (rejected: doubles the walk).

## Anti-goals

- A second timeline the owner has to line up with the first in their head (the "separate fixed
  timeline" option was rejected for exactly this).
- A guide save that can leave plans saved with some comparisons missing.
- Owner-entered fixed plans being overwritten by later estimate runs (today's precedence must hold).

## Approaches considered

- **A. Reuse the reference selection flow; extend the guide's history save (chosen).** Change in
  the editor uses the existing reference-scope selection (`TariffSelectionRequest` with
  `scope: .reference`, `publicPlan(label)` or `manual`, `effectiveFrom`/`effectiveTo`, preview then
  commit — what `FixedRatePlanDraft.makeSelectionRequest` already sends). The guide's
  `PUT utility/history` body gains an optional fixed comparison per period, written in the same
  transaction. iOS pairs plans and comparisons by date overlap. Chosen because it is the only option
  where the guide's save is atomic, and the editor needs no new server work.
- **B. Guide saves plans, then one reference selection per changed comparison.** No server change
  for the guide, but several requests, partial failure leaves comparisons half-saved, and a review
  screen per comparison at the end of the walk.
- **C. Server computes the pairing and returns it on each actual period.** Contract churn for a
  projection iOS can compute from data it already has; two sources of truth for every other reader
  of reference periods.

## Design

### Pairing (iOS, pure function)

For each actual period, its fixed comparison rows are the reference periods overlapping its dates,
clipped to them, oldest first. A plan spanning a utility rate change shows one row per revision.
Days of the plan no reference period covers produce a "No fixed comparison yet" row for that
sub-range. Build this as a small pure unit (e.g. `FixedComparisonPairing`) in
`Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/`, beside `RatePeriodResolver`, since
`TariffPeriodDTO` and `SiteTariffsTimelineResponse` now live in `PWUsageCore/SharedModels`
(PR #424). Test it in `PWUsageCoreTests/BillPricing` with `run-core-tests.sh`; both the editor and
the guide review use it.

Row content: fixed plan name, flat buy rate (`$0.16 / kWh`), `Estimated` when `source == .estimated`,
and a **Change** button.

```
Rate 2 Time-of-Use              Jan 2024 – Dec 2025
  Fixed comparison plan: Standard Residential
  $0.16 / kWh · Estimated                    [Change]
```

### Change (editor and guide)

Change opens a short picker for that row's date range:

- the utility's fixed plans in effect at the range start (`publicUtilityPlans(effectiveDate:)`,
  filtered to fixed plans) — in the guide, the year's fixed plans from `RatePlanHistoryDTO.years`;
- **Enter rates myself** → `FixedRatePlanForm` with the dates set and not editable there (no
  "Starts on" picker in this mode).

With no utility match, the row reads "No fixed comparison yet" and Change goes straight to Enter
rates myself.

In the **editor**, choosing commits a reference-scope selection for exactly the row's range through
the existing preview → `RatePlanReviewView` → commit path, then refreshes the timeline.

In the **guide**, choosing only updates the flow's staged choice for that plan; nothing is sent until
Save Rate Plans.

### Guide prefill and save

- **Prefill:** rows come from the site's current `referencePeriods` (already in the timeline iOS
  holds), run through the same pairing as the editor, so the guide shows exactly what is stored —
  server estimates and any owner-chosen comparisons alike. Only where no reference period covers a
  span does the guide fall back to the `isDefault` fixed plan (else the first fixed plan) from the
  year covering the span's start, staged as if the owner had picked it. *(Builder-check answer; my
  call.)*
- **A span that is itself a fixed plan** stages that same plan as its comparison and sends it
  explicitly: the owner confirmed being on it, so it becomes owner-chosen for that closed range.
  *(My call.)*
- **Otherwise untouched rows are not sent**: they stay as stored, so estimates keep updating
  estimated ones. Changed rows are sent and become owner-chosen reference periods that estimates
  never overwrite.
- **Granularity:** the guide shows one row per reference revision (same pairing) but offers one
  Change per plan; choosing replaces the comparison for the whole plan range (a label expands to
  that plan's revisions across the range). The editor offers Change per row. `fixed` stays one per
  period. *(My call.)*
- **Existing owner choices:** an absent `fixed` leaves every stored reference period untouched,
  owner-chosen or estimated. Rewriting the actual timeline never clips or deletes reference periods —
  the two timelines are independent. The guide only runs while unconfirmed days remain
  (`GET utility/history` returns 409 once filled); later edits go through the editor.
- **Choosing a utility plan follows that plan.** An owner choice by label (guide or editor) means
  "this plan", not "today's price". Closed ranges expand to the plan's revisions across the range.
  For the open (latest) range, the estimate job must keep picking up the chosen plan's later
  revisions, the way it follows the utility's standard plan today: the utility usually revises its
  Time-of-Use and fixed plans on the same dates, so the comparison should move with them. This needs
  the estimate job to remember the owner's chosen label for the open range (e.g. an
  `owner_selection` source row with `urdb_label`) and lay new revisions of that label instead of the
  default. Manual rates stay as entered until changed. *(Owner's call.)*
- **Gaps:** a utility with no fixed plan for some years can still save; those ranges keep the
  `noFixedRatePlan` savings caveat. Save is not blocked. *(My call.)*
- **Manual rates** apply as one flat all-day season over the whole range, as the form does today;
  `sellRate` defaults to 0 when left blank. *(My call.)*
- **Contract:** each entry in `PUT utility/history` `periods[]` gains an optional `fixed` member:
  `{ "label": "<urdb label>" }` or `{ "name": "...", "buyRate": n, "sellRate": n }`. Absent means
  "leave the estimate". Update `RatePlanHistoryPeriod` (iOS) and `parseHistoryPeriods` +
  `saveRatePlanHistory` (web) in the same PR (cross-app contract rule in `AGENTS.md`).
- **Server write:** inside the `saveRatePlanHistory` transaction, for each period with `fixed`, apply
  the same write a reference-scope selection commit does for that range (label → expand revisions
  across the range like `expandHistoryPeriod`; manual → one flat season), then re-run
  `applyEstimatesOnClient(..., 'reference')` so estimates fill only what is left. Any failure rolls
  back the whole save.

### Removing the standalone entry points

- Bill savings card and Solar System savings section: the separate fixed buttons ("Add Fixed Rate
  Plan" / "Edit Plan") are replaced by one rate plan button, since fixed comparisons now live with
  rate plans: **Add Rate Plans** when the site has none, otherwise **Edit Rate Plans**. It opens the
  rate plan editor (`RatePlansSheet` / `TariffSheet`) scrolled to the plan active today. The setup
  prompt copy drops "fixed rate plan" and talks about rate plans. *(Owner's call.)*
- The savings `noFixedRatePlan` caveat opens the editor at the first plan with an uncovered
  sub-range.
- `FixedRatePlanForm` survives only as the Enter rates myself screen.
- Demo mode (`DemoAPI`) follows the same paths; its fixtures need reference periods spanning more
  than one actual plan so the pairing is visible.

### Copy

Follow `docs/voice-and-terms.md`: "fixed comparison plan" in user-facing text; "rate plan" for the
actual plan. Footer for the row group: "Savings compare each plan with this fixed plan. Changing it
never changes the plan for your energy."

## Constraints

- iOS CI: `lint.sh` (swiftformat + swiftlint `--strict`), zero compiler warnings; core logic tests
  via `run-core-tests.sh`, simulator tests via `run-tests.sh` (see `cmd/ios-app/AGENTS.md`).
- Web: append-only tariff versioning and reference precedence rules in `DesignDecisions.md` hold.
- iOS is in beta: change the mobile API in place, no version gates.

## Left to the builder

- Exact placement of comparison rows inside `TariffPeriodCardView` vs a sub-row in the timeline list.
- Whether the editor's picker shows plans at the range start only or flags plans that change mid-range.
- How the guide review renders many rows (collapse beyond two per plan, etc.).
