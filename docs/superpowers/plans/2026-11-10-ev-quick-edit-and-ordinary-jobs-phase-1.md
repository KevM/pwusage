# Smart Shift Phase 1: ordinary jobs, multiple EVs and the quick charge sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner switch EVs and set current/target charge in 5% steps from a quick sheet on the Smart Shift card, by making every saved job an ordinary, deletable job and allowing several EVs.

**Architecture:** `LoadProfileStore` (UserDefaults JSON, schema bumped to 3) drops its built-in/reserved-id rules and gains car creation, duplication, a remembered last EV and a focused `updateCarCharge` method. A small pure helper owns the 5% stepping rules. The Smart Shift card shows a car summary line that opens a half-sheet quick editor which writes through the store. Manage Jobs and the editor are updated to match.

**Tech Stack:** Swift / SwiftUI, Swift Testing (`@Test`, `#expect`), XcodeGen project (new files need no project edit).

**Spec:** `docs/superpowers/specs/2026-11-10-job-templates-and-ev-quick-edit-design.md` (Phase 2 — templates, Small/Medium/Large, the Tesla charge-source seam — gets its own plan after this lands.)

## Global Constraints

- iOS only, `cmd/ios-app`; no change to `cmd/next-app` or `MobileLiveContract`.
- Jobs stay on-device in UserDefaults (`LoadProfileStore.storageKey`).
- Charge controls move in **5% steps**; current and target stay within 0–100; target is never below current.
- Copy follows `docs/voice-and-terms.md` (never bare "job"; sentence case for body, Title Case for buttons as in existing sheets).
- `./cmd/ios-app/lint.sh` must pass clean (SwiftFormat + SwiftLint `--strict`) and builds must have zero compiler warnings; no `swiftlint:disable`.
- Tests: `./cmd/ios-app/run-tests.sh --quick <SuiteName>` while iterating (cap runs with `PWUSAGE_TEST_TIMEOUT_SECONDS`, about 2× usual); plain `./cmd/ios-app/run-tests.sh` before the final handoff. TDD: failing test first.
- Existing saved v1/v2 payloads must load without losing any job, edit or selection.
- Dynamic Type accessibility sizes and VoiceOver must work for new views (follow the patterns already in `LoadProfilesSheet`/`ProfileEditorSheet`).

## Review Focus

Most likely to bite first:

1. **Delete-everything round trip** — an empty saved `profiles` array reopens empty (the `.noJobs` card), never re-seeded; covered in Task 1.
2. **Deleting the selected job or the last-used EV** — selection falls to the first remaining job (or nil), `lastEVProfileID` falls to another EV (or nil); a saved selection id that no longer exists is ignored on load; covered in Tasks 1 and 3.
3. **Off-grid saved charge (e.g. 37%)** — shown as saved, +5 gives 40, −5 gives 35, and target is re-clamped; covered in Task 3.
4. **Charge extremes** — current 100 / target 100, current 0, raising current above target raises target, lowering current leaves target; covered in Task 3.
5. **Upgrade from v1/v2 payloads** — the six old ids (`car`, `dishwasher`, `washer`, `dryer`, `washer-dryer-combo`, `custom-example`) load as ordinary deletable jobs with their edits intact; covered in Task 1.

---

## File Structure

- Modify `PWUsage/Models/LoadTiming/LoadProfile.swift`: error cases.
- Modify `PWUsage/State/LoadTiming/LoadProfileStore.swift`: ordinary jobs, schema 3, cars, duplicate, last EV, charge updates.
- Create `PWUsage/Models/LoadTiming/CarChargeSteps.swift`: pure 5% stepping rules.
- Modify `PWUsage/Views/LoadTiming/ProfileDraft.swift`, `ProfileEditorSheet.swift`, `LoadProfilesSheet.swift`: rename any job, 5% steps, Add a Car, Duplicate/Delete menu.
- Modify `PWUsage/Views/LoadTiming/LoadTimingPresentation.swift`: `carSummary`.
- Create `PWUsage/Views/LoadTiming/CarQuickEditSheet.swift`: the half sheet.
- Modify `PWUsage/Views/LoadTiming/LoadTimingView.swift`: summary row and sheet wiring.
- Tests: `PWUsageTests/LoadProfileStoreTests.swift`, new `CarChargeStepsTests.swift`, `ProfileDraftTests.swift`, `LoadTimingViewTests.swift` / a presentation test file as the repo does for `LoadTimingPresentation`.

---

### Task 1: Every job is an ordinary job

**Files:**
- Modify: `PWUsage/State/LoadTiming/LoadProfileStore.swift`, `PWUsage/Models/LoadTiming/LoadProfile.swift`
- Test: `PWUsageTests/LoadProfileStoreTests.swift`

**Interfaces:**
- Produces: `LoadProfileStore.schemaVersion == 3`; `@Published private(set) var selectedProfileID: String?`; `func deleteProfile(id: String) throws` (replaces `deleteCustomProfile`; deletes any kind); `resetBuiltInProfile` and `LoadProfileError.cannotDeleteBuiltIn` / `.cannotResetCustom` removed. A saved collection with zero profiles loads as empty. Fresh installs (no saved data) still seed the six starter jobs once with the same ids and values.
- Consumes: nothing.

- [ ] **Step 1: Rewrite the built-in tests as failing tests.** Replace `editsAndResetsBuiltIns`, `recoversReservedIDKindMismatch` and the custom-only delete assumptions with: `deletesAnyJob` (delete `"car"` and `"dishwasher"`, both gone), `deletingAllJobsPersistsEmpty` (delete all six, reopen via `LoadProfileStore(userDefaults: fixture.defaults)`, `#expect(restored.profiles.isEmpty)` and `restored.selectedProfileID == nil`), `deletingSelectedJobSelectsFirstRemaining`, `staleSavedSelectionIsIgnored` (saved `selectedProfileID` pointing at a missing job → first profile, or nil if none), and `v2PayloadKeepsEveryJobAndEdit` (write a v2 JSON payload with an edited `dishwasher` and a custom UUID job; all load unchanged and are deletable). Keep `deleteCustomProfile` call sites compiling by migrating them to `deleteProfile`.
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick LoadProfileStoreTests`. Expected: FAIL (compile errors / assertions).
- [ ] **Step 3: Implement** in `LoadProfileStore`: bump `schemaVersion` to 3 and accept versions 1…3 in `loadCollection`; make `selectedProfileID` optional and reconcile it on load and after every mutation; relax `isValidCollection` to "unique ids, every profile passes `validate`" (no reserved-id/kind/UUID checks); allow an empty array; delete the `resetBuiltInProfile` method and the two error cases (and their text in `LoadProfileError`). Keep `renamedForVersionTwo` for v1 payloads. Seeding only happens when no saved data decodes at all.
- [ ] **Step 4: Update callers** (`LoadProfilesSheet`, `LoadTimingView.initialJobID`, anything else the compiler flags) minimally so the app builds; UI polish comes in Task 4.
- [ ] **Step 5: Run** `./cmd/ios-app/run-tests.sh --quick LoadProfileStoreTests` then `./cmd/ios-app/lint.sh`. Expected: PASS, lint clean.
- [ ] **Step 6: Commit** `feat(ios): make every Smart Shift job an ordinary deletable job`.

---

### Task 2: Cars you can add, duplicate and rename

**Files:**
- Modify: `PWUsage/State/LoadTiming/LoadProfileStore.swift`
- Test: `PWUsageTests/LoadProfileStoreTests.swift`

**Interfaces:**
- Produces:
  - `@discardableResult func createCarProfile(name: String, settings: CarLoadSettings) throws -> LoadProfile` — `kind == .car`, UUID id, appended, `energyKwh`/`durationHours` derived from `LoadTimingEstimator.carChargeEstimate(settings:)` (as the seeded car does).
  - `@discardableResult func duplicateProfile(id: String) throws -> LoadProfile` — new UUID, name `"<name> copy"`, inserted directly after the source, same kind and values.
  - `editProfile(id:name:energyKwh:durationHours:carSettings:)` now renames **any** kind when `name` is non-nil (still trimmed, still non-empty).
- Consumes: Task 1's store.

- [ ] **Step 1: Write failing tests:** `createsASecondCarWithItsOwnCapacity` (two cars, capacities 60 and 40, both persisted across a reopen), `duplicateInsertsAfterSourceWithCopyName` (including duplicating a car keeps its settings), `renamesAnyJob` (`"dishwasher"` → `"Dishwasher (garage)"`), `rejectsBlankCarName`.
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick LoadProfileStoreTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the three behaviours above; `validate` requires a non-empty name for every kind.
- [ ] **Step 4: Run tests and** `./cmd/ios-app/lint.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): add, duplicate and rename Smart Shift jobs`.

---

### Task 3: 5% charge rules, last-used EV, quick charge updates

**Files:**
- Create: `PWUsage/Models/LoadTiming/CarChargeSteps.swift`
- Modify: `PWUsage/State/LoadTiming/LoadProfileStore.swift`
- Test: create `PWUsageTests/CarChargeStepsTests.swift`; extend `PWUsageTests/LoadProfileStoreTests.swift`

**Interfaces:**
- Produces (all in `enum CarChargeSteps`, pure):
  - `static let step = 5.0`
  - `static func snapped(_ value: Double) -> Double` — nearest multiple of 5 in 0…100 (ties round up).
  - `static func steppedUp(_ value: Double) -> Double` = `min(100, snapped(value) + 5)`; `steppedDown` = `max(0, snapped(value) - 5)`.
  - `static func settings(_ settings: CarLoadSettings, settingCurrent value: Double) -> CarLoadSettings` — snapped current; target raised to current if below, otherwise unchanged.
  - `static func settings(_ settings: CarLoadSettings, settingTarget value: Double) -> CarLoadSettings` — snapped target, never below current.
- Produces on the store: `@Published private(set) var lastEVProfileID: String?` (persisted as an optional field of `PersistedCollection`, decodes as nil from v1/v2 payloads); `var carProfiles: [LoadProfile]`; `func updateCarCharge(id: String, current: Double?, target: Double?) throws` (applies `CarChargeSteps`, recomputes `energyKwh`/`durationHours`, persists; throws `.profileNotFound` for unknown ids and `.invalidProfile` for non-car jobs).
- Behaviour: `selectProfile(id:)` sets `lastEVProfileID` when the job is a car; deleting that car moves `lastEVProfileID` to another car or nil; on load the id is validated against existing cars.

- [ ] **Step 1: Write failing tests** in `CarChargeStepsTests`: `snapsToNearestFive` (37 → 35, 38 → 40, 2.5 → 5, 100 → 100), `stepsFromOffGridValues` (37 up → 40, 37 down → 35, 100 up → 100, 0 down → 0), `raisingCurrentAboveTargetRaisesTarget` (current 85 with target 80 → target 85), `loweringCurrentKeepsTarget`, `targetNeverBelowCurrent` (current 40, set target 35 → 40), `currentAndTargetBothAtHundred`. In the store tests: `updateCarChargePersistsAndRecomputesEstimate`, `rejectsNonCarJob`, `lastEVFollowsSelectionOfCars` (selecting the dishwasher leaves `lastEVProfileID` unchanged), `deletingLastEVFallsBackToAnotherCar`, `lastEVIsNilWithNoCars`, `v2PayloadHasNoLastEV`.
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick CarChargeStepsTests LoadProfileStoreTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `CarChargeSteps` and the store additions above.
- [ ] **Step 4: Run tests and** `./cmd/ios-app/lint.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): 5% charge rules and last-used EV`.

---

### Task 4: Manage Jobs and the editor match the new model

**Files:**
- Modify: `PWUsage/Views/LoadTiming/LoadProfilesSheet.swift`, `ProfileEditorSheet.swift`, `ProfileDraft.swift`
- Test: `PWUsageTests/ProfileDraftTests.swift`

**Interfaces:**
- Produces: `ProfileDraft.newCar() -> ProfileDraft` (name `"Car"`, `CarLoadSettings` with the store's `Defaults` values, `kind == .car`, `id == nil`); `ProfileDraft.isValid` requires a non-empty name for every kind; `LoadProfilesSheet.save` creates a car through `store.createCarProfile` when `draft.id == nil && draft.kind == .car`.
- Consumes: Tasks 1–3.

- [ ] **Step 1: Write failing tests** in `ProfileDraftTests`: `newCarDraftIsValidAndUsesCarDefaults`, `blankNameIsInvalidForEveryKind`, and `changingCarNameIsAnUnsavedChange`.
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick ProfileDraftTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `ProfileDraft` changes. In the editor, show the name field for every kind; set the "Current charge" and "Target charge" steppers to step 5 (display exact stored values, snap on first edit through `CarChargeSteps`); title `New Car` / `Edit Job`.
- [ ] **Step 4: Update `LoadProfilesSheet`:** add an "Add a Car" button next to "Add a Custom Job"; the row menu offers Edit, Duplicate, Delete for every job (Delete confirms with "Delete <name>?" and "This removes the job from this device."); remove "Reset to Defaults" and its dialog; update the footer copy and any alert text so nothing mentions built-ins.
- [ ] **Step 5: Run** `./cmd/ios-app/run-tests.sh --quick ProfileDraftTests LoadProfileStoreTests` and `./cmd/ios-app/lint.sh`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ios): manage cars and ordinary jobs in Manage Jobs`.

---

### Task 5: The summary line and quick charge sheet

**Files:**
- Create: `PWUsage/Views/LoadTiming/CarQuickEditSheet.swift`
- Modify: `PWUsage/Views/LoadTiming/LoadTimingPresentation.swift`, `LoadTimingView.swift`, `docs/voice-and-terms.md` (only if new terms need listing)
- Test: `PWUsageTests` file that covers `LoadTimingPresentation` (extend it, or add `CarSummaryPresentationTests.swift` if none exists)

**Interfaces:**
- Produces: `LoadTimingPresentation.carSummary(_ profile: LoadProfile) -> String?` returning `"<name> · <current>% → <target>%"` (integers, e.g. `"Model Y · 30% → 80%"`) for car jobs with settings, otherwise nil; `struct CarQuickEditSheet: View` with `init(store: LoadProfileStore, selectedID: Binding<String?>/or onSelect: (String) -> Void)` — car chips from `store.carProfiles`, a Current charge control and a Charge to control, each with −5/+5 buttons and a 5%-segmented slider, writing through `store.updateCarCharge` on every change.
- Behaviour: the summary row appears in `jobCard` only while the selected job is a car, with an "Edit" affordance (≥ 44 pt, accessibility label `"Edit <summary>"`). The sheet uses a small detent with `.presentationBackgroundInteraction(.enabled)` so the card's verdict stays visible and updates while dragging; selecting a chip calls the existing `selectJob`. Switching selection from the picker or the chips updates `lastEVProfileID` (Task 3).
- Consumes: Tasks 1–4.

- [ ] **Step 1: Write failing tests** for `carSummary`: `formatsNameAndCharge` (`"Model Y · 30% → 80%"`), `isNilForNonCarJobs`, `roundsOffGridValuesForDisplay` (37.0 → `37%`, shown exactly as saved).
- [ ] **Step 2: Run** the presentation suite via `./cmd/ios-app/run-tests.sh --quick <SuiteName>`. Expected: FAIL.
- [ ] **Step 3: Implement** `carSummary`, `CarQuickEditSheet` (extract subviews; keep bodies small for `-O` type-checking) and wire the row and sheet into `LoadTimingView` (`@State var isCarSheetPresented`). Update `onChange(of: profileStore.profiles)` handling so deleting the explored job still resets `exploredProfileID`.
- [ ] **Step 4: Run** `./cmd/ios-app/run-tests.sh` (default) and `./cmd/ios-app/lint.sh`. Expected: all pass, zero warnings.
- [ ] **Step 5: Verify in the simulator** (build and launch via the iOS simulator tool): with two cars, switch cars from the sheet, press −5/+5 and drag a slider, confirm the verdict behind the sheet updates and VoiceOver labels read "Current charge, 30 percent". Capture screenshots; at an accessibility Dynamic Type size confirm the sheet doesn't clip.
- [ ] **Step 6: Commit** `feat(ios): quick charge sheet on the Smart Shift card`.

---

## Self-review notes

- Spec coverage: fast charge entry (Tasks 3, 5), fast car switching (Task 5), multiple EVs (Task 2), ordinary jobs (Tasks 1, 4), 5% steps (Tasks 3–5), migration (Task 1), last-used EV (Task 3), "Add a Car" empty-state recovery (Task 4), sheet presentation (Task 5). Templates, Small/Medium/Large and the charge-source seam are Phase 2 by the spec's own ordering.
- Names used across tasks: `deleteProfile`, `createCarProfile`, `duplicateProfile`, `updateCarCharge`, `carProfiles`, `lastEVProfileID`, `CarChargeSteps`, `carSummary`, `CarQuickEditSheet`.
