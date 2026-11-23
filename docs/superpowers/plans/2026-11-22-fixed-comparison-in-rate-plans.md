# Fixed Comparison Plans in the Rate Plan UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and change each historic rate plan's fixed comparison plan next to that plan, in Find My Rate Plans and the rate plan editor, and save the guide's choices in one transaction.

**Architecture:** Fixed comparisons stay stored as dated reference periods. The server learns two things: an optional `fixed` per period on `PUT utility/history`, and a site-level "followed reference label" so an open-ended utility plan choice keeps picking up that plan's revisions. iOS pairs actual and reference periods with a pure `PWUsageCore` function, then renders comparison rows with a Change button in the guide review and in `TariffSheet`. The standalone fixed rate plan entry points become one "Add/Edit Rate Plans" button.

**Tech Stack:** Next.js route handlers + Postgres (`cmd/next-app`, vitest), SwiftUI (`cmd/ios-app`), `PWUsageCore` Swift package (Swift Testing).

**Spec:** `docs/superpowers/specs/2026-11-22-fixed-comparison-in-rate-plans-design.md`

## Global Constraints

- User-facing term: "fixed comparison plan"; "rate plan" for the actual plan (`docs/voice-and-terms.md`).
- Row footer copy: "Savings compare each plan with this fixed plan. Changing it never changes the plan for your energy."
- Mobile ⇄ web contract changes land on both sides in the same PR (`AGENTS.md`). iOS is beta: change in place, no version gates.
- Migrations only via `npm run db:migration:create <name>` in `cmd/next-app` — never hand-named files.
- iOS: `./lint.sh` clean, zero compiler warnings, no trailing commas; `./run-core-tests.sh` for `PWUsageCore`, `./run-tests.sh --quick <Suite>` while iterating, plain `./run-tests.sh` before PR.
- Web: `npm run lint`, `npm run typecheck`, `npx vitest --run <file>`.
- Owner-chosen reference periods are never overwritten by estimate runs; untouched estimated rows are never sent by the guide.
- Savings math (`SavingsCalculator`, `RatePeriodResolver`) does not change.

## Review Focus

1. A guide plan whose dates span a utility fixed-plan revision shows two rows, and one Change replaces both — test in Task 5 (`changeReplacesAllRowsForSpan`).
2. A site with no reference periods and no fixed plan for a year saves successfully, leaving that range uncovered — tests in Task 2 (`savesWithUncoveredFixedRange`) and Task 4 (`uncoveredWholeSpanYieldsGapRow`).
3. Re-saving the guide with no `fixed` members leaves existing owner-chosen reference periods byte-for-byte untouched — test in Task 2 (`absentFixedKeepsOwnerReferences`).
4. A followed label whose newest revision appears after the owner chose it is laid by the next estimate run — test in Task 1 (`followsNewRevisionOfChosenLabel`).
5. Demo mode (no auth) opens Add/Edit Rate Plans from both savings cards without a network call failing — test in Task 7 (`demoSavingsButtonOpensRatePlans`).

---

### Task 1: Followed reference label in the estimate job

**Files:**
- Create: migration via `npm run db:migration:create site_utility_reference_label`
- Modify: `cmd/next-app/src/lib/urdb/estimate-job.ts` (snapshot query + reference spans at line ~138)
- Modify: `cmd/next-app/scripts/sanitize-dev-copy.sql` only if it enumerates `SiteUtility` columns
- Test: `cmd/next-app/src/lib/urdb/estimate-job.test.ts`

**Interfaces:**
- Produces: columns `"SiteUtility".urdb_reference_label text NULL`, `"SiteUtility".urdb_reference_from date NULL` (both set or both null; add a CHECK).
- Produces: `referenceDesiredSpans(defaults: RevisionSpan[], followed: RevisionSpan[], followedFrom: string | null): RevisionSpan[]` exported from `estimate-job.ts` — defaults clipped to end the day before `followedFrom`, followed spans clipped to start on `followedFrom`.

- [ ] **Step 1: Write failing tests** in `estimate-job.test.ts`:
  - `referenceDesiredSpans` with defaults `[A 2023-01-01→2024-12-31, B 2025-01-01→null]`, followed `[X 2024-06-01→null]`, from `2024-06-01` → `[A 2023-01-01→2024-05-31, X 2024-06-01→null]`.
  - `followsNewRevisionOfChosenLabel`: preview with `urdb_reference_label='X1'`, `urdb_reference_from='2025-03-01'`, fake api where `rateByLabel('X1')` supersedes to `X2` starting 2026-01-01 → `preview.reference` labels from 2025-03-01 are `['X1','X2']`, both role `estimated_reference`.
  - Null label → reference identical to today's defaults-only output.
- [ ] **Step 2: Run** `npx vitest --run src/lib/urdb/estimate-job.test.ts` → FAIL (`referenceDesiredSpans` not exported).
- [ ] **Step 3: Create the migration** with the generator, adding the two columns and `CHECK ((urdb_reference_label IS NULL) = (urdb_reference_from IS NULL))`.
- [ ] **Step 4: Implement.** Read both columns in the snapshot `SiteUtility` query; when set, build followed spans with `walkSupersedes(await api.rateByLabel(label), api.rateByLabel, { endBefore: null, maxSteps: MAX_REVISIONS, timeZone })` filtered to fixed rates, and feed `referenceDesiredSpans(defaults, followed, from)` to the existing `reference` mapping in place of `defaults`.
- [ ] **Step 5: Run** the test file → PASS; `npm run typecheck` → clean.
- [ ] **Step 6: Commit** `feat(web): follow an owner-chosen fixed comparison plan's revisions`.

### Task 2: `fixed` on the rate plan history save

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/utility/history/route.ts` (`parseHistoryPeriods`, `PUT`)
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`saveRatePlanHistory`, line ~2997)
- Test: `cmd/next-app/src/app/api/site/[id]/utility/history/route.test.ts`, `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts` (`describe('saveRatePlanHistory')`)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces (wire): each `periods[]` item may carry `fixed: { label: string } | { name: string; buyRate: number; sellRate: number }`. Absent = leave stored reference periods alone.
- Produces (repo): `saveRatePlanHistory(siteId, userId, expectedUtility, revisions, openLabel, fixed: FixedComparisonWrite[])` where
  `type FixedComparisonWrite = { from: string; to: string | null } & ({ kind: 'public'; revisions: ExpandedRevision[] } | { kind: 'manual'; name: string; buyRate: number; sellRate: number })`.

- [ ] **Step 1: Write failing route tests:** `fixed` with label is passed through expanded; manual with `buyRate` ≤ 0 or non-number → 400 "Enter a price per kWh."; `sellRate` missing → treated as 0; unknown keys in `fixed` → 400 "Invalid request body."; a period without `fixed` produces no `FixedComparisonWrite`.
- [ ] **Step 2: Write failing Postgres tests:**
  - `writesClosedFixedAsOwnerReference`: closed period 2024-01-01→2024-12-31 with label → `TariffReferencePeriod` rows over exactly that range, selection `choice_kind='owner'`, scope reference.
  - `openFixedLabelSetsFollowedLabel`: open period with label → `SiteUtility.urdb_reference_label` = label, `urdb_reference_from` = period `from`, and no owner reference row for the open range.
  - `openFixedManualIsOwnerOpenEnded`: open manual → one owner reference period with `effective_to IS NULL`, buy rate as sent.
  - `absentFixedKeepsOwnerReferences`: pre-existing owner reference period survives a save without `fixed`, unchanged id and dates.
  - `savesWithUncoveredFixedRange`: no reference data, no `fixed` → save succeeds.
  - Rollback: a `fixed` write that fails validation leaves no new actual rows either.
- [ ] **Step 3: Run** both files → FAIL.
- [ ] **Step 4: Implement parsing** in `parseHistoryPeriods` (allow keys `label, from, to, fixed`); in `PUT`, expand label `fixed` with `expandHistoryPeriod({ label, from, to }, sameCtx)`; manual becomes one flat all-day season via the same season shape `FixedRatePlanDraft` sends (single `OFF_PEAK` 0–24 weekday and weekend window).
- [ ] **Step 5: Implement the repo write** inside the existing transaction, after the actual revisions and before `applyEstimatesOnClient`: closed ranges → `applyTariffSelectionOnClient(client, siteId, today, { scope: 'reference', effectiveFrom, effectiveTo, userId, candidate })` per revision (public) or once (manual); open label → `UPDATE "SiteUtility" SET urdb_reference_label, urdb_reference_from` and clear any owner reference period covering the open range from `from`; open manual → `applyTariffSelectionOnClient` with `effectiveTo: null`. The existing `applyEstimatesOnClient(client, siteId, today)` then fills what is left.
- [ ] **Step 6: Run** both test files (`npx vitest --run …`; Postgres suite needs its test socket) → PASS; lint + typecheck clean.
- [ ] **Step 7: Commit** `feat(web): save fixed comparison plans with rate plan history`.

### Task 3: Open-ended label choice from the editor follows the plan

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-selection-service.ts` (`commitTariffSelection`, line ~586) and its preview counterpart
- Test: `cmd/next-app/src/lib/tariff-selection.test.ts`, `tariff-timeline-repo-postgres.test.ts`

**Interfaces:**
- Consumes: Task 1 columns; same "open label" write as Task 2 (extract it as `setFollowedReferenceLabelOnClient(client, siteId, userId, label, from): Promise<void>` in `tariff-timeline-repo.ts` and reuse in Task 2).

- [ ] **Step 1: Failing tests:** reference-scope commit with `candidate.kind === 'public'` and `effectiveTo === null` sets the followed label/from and lays `estimated_reference` revisions of that label from `from`; preview for the same request reports the same resulting spans; closed-range public and any manual commit behave exactly as today.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the branch in commit and preview; any later closed-range or manual reference commit that starts on or before `urdb_reference_from` clears the followed label.
- [ ] **Step 4: Run** → PASS; lint + typecheck.
- [ ] **Step 5: Commit** `feat(web): follow a utility fixed plan chosen for the current rate plan`.

### Task 4: `FixedComparisonPairing` in PWUsageCore

**Files:**
- Create: `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/FixedComparisonPairing.swift`
- Test: `cmd/ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/BillPricing/FixedComparisonPairingTests.swift`

**Interfaces:**
- Produces:
  ```swift
  public struct FixedComparisonRow: Equatable, Sendable {
      public let from: String          // YYYY-MM-DD, clipped to the plan
      public let to: String?           // nil = open
      public let reference: TariffPeriodDTO?  // nil = "No fixed comparison yet"
  }
  public enum FixedComparisonPairing {
      public static func rows(for plan: (from: String, to: String?), references: [TariffPeriodDTO]) -> [FixedComparisonRow]
  }
  ```

- [ ] **Step 1: Failing tests:** one reference covering the plan → one row clipped to plan dates; reference revision mid-plan → two rows split on the revision date; reference starts after plan start → leading gap row then reference row; `uncoveredWholeSpanYieldsGapRow` (no references) → one row with `reference == nil`; open plan + open reference → row `to == nil`; references unsorted input → rows oldest first.
- [ ] **Step 2: Run** `./run-core-tests.sh --filter FixedComparisonPairingTests` → FAIL.
- [ ] **Step 3: Implement** with string date comparison (dates are `YYYY-MM-DD`), using `effectiveFrom`/`effectiveTo` on `TariffPeriodDTO`.
- [ ] **Step 4: Run** → PASS; `./lint.sh` clean.
- [ ] **Step 5: Commit** `feat(ios): pair rate plans with fixed comparison plans`.

### Task 5: Guide stages and sends fixed comparisons

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryDTO.swift` (`RatePlanHistoryPeriod`)
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryFlow.swift` (`Span`, `periods()`), `RatePlanHistoryFlow+Review.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryModel.swift` (pass `referencePeriods` in)
- Modify: `cmd/ios-app/PWUsage/Demo/DemoAPI.swift` (`saveRateHistory` accepts `fixed`)
- Test: `cmd/ios-app/PWUsageTests/` existing `RatePlanHistoryFlow` suite (add cases), plus encoding test beside existing `RatePlanHistoryPeriod` tests

**Interfaces:**
- Consumes: `FixedComparisonPairing.rows` (Task 4).
- Produces:
  ```swift
  enum FixedComparisonChoice: Equatable, Sendable {
      case publicPlan(label: String, name: String, buyRate: Double)
      case manual(name: String, buyRate: Double, sellRate: Double)
  }
  // RatePlanHistoryPeriod gains `let fixed: FixedComparisonChoice?`, encoded as
  // {"label":…} or {"name":…,"buyRate":…,"sellRate":…}; omitted when nil.
  // RatePlanHistoryFlow gains:
  var referencePeriods: [TariffPeriodDTO]            // set at init
  func comparisonRows(forSpanAt index: Int) -> [FixedComparisonRow]
  func stagedFixed(forSpanAt index: Int) -> FixedComparisonChoice?
  mutating func chooseFixed(_ choice: FixedComparisonChoice, forSpanAt index: Int)
  ```

- [ ] **Step 1: Failing tests:**
  - Encoding: `fixed == nil` omits the key; public encodes `{"label":"L"}` only; manual encodes name/buyRate/sellRate.
  - Prefill from stored references: span covered by references → `stagedFixed == nil`, `periods()` has no `fixed`.
  - Fallback: span with no references → staged = year's `isDefault` fixed plan (else first fixed plan) and sent.
  - Span that is itself a fixed plan → staged = that plan, sent.
  - `changeReplacesAllRowsForSpan`: span with two reference rows, `chooseFixed` once → `periods()` carries that one `fixed` for the whole span, and `comparisonRows` reflects the staged choice as a single row.
  - Undo (existing snapshot stack) restores the previous staged choice.
- [ ] **Step 2: Run** `./run-tests.sh --quick RatePlanHistoryFlowTests` → FAIL.
- [ ] **Step 3: Implement**; staged choices live on `Span` (`var fixed: FixedComparisonChoice?`, `var fixedWasChanged: Bool`) so `reopenSpan` and undo keep working.
- [ ] **Step 4: Run** → PASS; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): stage fixed comparison plans in Find My Rate Plans`.

### Task 6: Comparison rows and Change in the guide review and the editor

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Bill/FixedComparisonRowsView.swift` (rows + Change button, used by both screens)
- Create: `cmd/ios-app/PWUsage/Views/Bill/FixedComparisonPicker.swift` (list of fixed plans + "Enter rates myself")
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RatePlanHistoryReviewView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift` (under each `TariffPeriodCardView`, line ~166)
- Modify: `cmd/ios-app/PWUsage/Views/Bill/FixedRatePlanForm.swift` (locked-dates mode)
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryPresentation.swift` (copy)
- Test: presentation/unit tests for copy and picker filtering in `PWUsageTests`

**Interfaces:**
- Consumes: `FixedComparisonRow`, `FixedComparisonChoice`, `RatePlanHistoryFlow.chooseFixed`, `publicUtilityPlans(siteID:effectiveDate:)`, `previewTariffSelection` / `commitTariffSelection` with `TariffSelectionRequest(scope: .reference, candidate:, effectiveFrom:, effectiveTo:)`.
- Produces: `FixedRatePlanForm(lockedRange: (from: String, to: String?), …)` — hides "Starts on"/"Edit Dates", sends exactly that range; `FixedComparisonPicker.fixedPlans(_ plans: [UtilityPlanDTO]) -> [UtilityPlanDTO]` (keeps `kind == .fixed`, `isDefault` first).

- [ ] **Step 1: Failing tests:** `fixedPlans` filters and orders; row label copy: name, `"$0.16 / kWh"` (currency formatted), `"Estimated"` when `source == .estimated`, `"No fixed comparison yet"` for gap rows; footer string equals the Global Constraints copy.
- [ ] **Step 2: Run** `./run-tests.sh --quick <new suites>` → FAIL.
- [ ] **Step 3: Implement the views.** Guide: one Change per plan (calls `chooseFixed`), picker fed by the year's fixed plans from `RatePlanHistoryDTO.years`. Editor: Change per row; picker fed by `publicUtilityPlans(effectiveDate: row.from)`; a choice runs the existing preview → `RatePlanReviewView` → commit path for the row's range. Gap rows (or no fixed plans) open `FixedRatePlanForm(lockedRange:)` directly.
- [ ] **Step 4: Run** tests → PASS; build with zero warnings; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): show and change fixed comparison plans beside rate plans`.

### Task 7: Replace the standalone fixed rate plan entry points

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/Bill/BillSavingsCard.swift`, `BillView.swift` (remove `.fixedRatePlan` sheet case; route to `.ratePlans(startsAdding:)`)
- Modify: `cmd/ios-app/PWUsage/Views/SolarSystem/SolarSystemSavingsSection.swift`, `SolarSystemView.swift` (remove `.fixedRatePlan`; route to `.ratePlans`)
- Modify: `cmd/ios-app/PWUsage/Views/Shared/SavingsPresentation.swift` (`SavingsCaveat.Action.editFixedRatePlan` → opens rate plans; title "Edit Rate Plans")
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Savings.swift` (delete `saveFixedRatePlan`/`removeFixedRatePlan` if no longer referenced; keep `activeReferencePeriod` only if still used)
- Modify: `cmd/ios-app/PWUsage/Demo/DemoFixtures+RateHistory.swift` (reference periods spanning two actual plans, one mid-plan revision)
- Test: existing savings presentation tests + `demoSavingsButtonOpensRatePlans`

**Interfaces:**
- Consumes: Task 6 views inside `TariffSheet` (that is where fixed comparisons are now edited).
- Produces: savings button title `"Add Rate Plans"` when the site has no rate plan periods, else `"Edit Rate Plans"`; setup prompt copy without "fixed rate plan".

- [ ] **Step 1: Failing tests:** button title switches on `periods.isEmpty`; caveat action title `"Edit Rate Plans"`; `demoSavingsButtonOpensRatePlans` — in demo mode the savings action resolves to the rate plans sheet and loading it makes no failing API call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; delete dead code the compiler or `./periphery.sh` flags.
- [ ] **Step 4: Run** tests → PASS; zero warnings; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): edit fixed comparison plans from Rate Plans`.

### Task 8: Full verification

- [ ] **Step 1:** `cd cmd/next-app && npm run lint && npm run typecheck && npx vitest --run` → all pass.
- [ ] **Step 2:** `cd cmd/ios-app && ./lint.sh && ./run-core-tests.sh && ./run-tests.sh` → all pass, zero warnings.
- [ ] **Step 3:** Run the app in the simulator (Demo mode): Bill → Edit Rate Plans shows comparison rows under each plan with a split row where the demo revision falls; Change → picker → Enter rates myself shows no start-date picker.
- [ ] **Step 4:** Update `TODO.md` with the savings cost-table follow-up; open a draft PR with web + iOS changes together.
