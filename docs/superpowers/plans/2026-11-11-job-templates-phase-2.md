# Smart Shift Phase 2: job templates, Small/Medium/Large jobs and the charge-source seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding a job starts from a short template list; custom jobs are set by a Small/Medium/Large size with size-scaled steps; an EV's current charge comes through a swappable source so a later Tesla sync can drop in.

**Architecture:** Two optional fields on `LoadProfile` (`size`, `actionVerb`) carry the new data; no schema bump (old payloads decode them as nil). A data-only `JobTemplates` list builds `ProfileDraft`s. One store method, `addProfile`, becomes the single creation path. A runtime-only `CarChargeSource` protocol (manual implementation now) feeds the quick charge sheet.

**Tech Stack:** Swift / SwiftUI, Swift Testing, XcodeGen (new files need no project edit).

**Spec:** `docs/superpowers/specs/2026-11-10-job-templates-and-ev-quick-edit-design.md` (Phase 1 is merged: PR #348).

## Global Constraints

- iOS only, `cmd/ios-app`; no change to `cmd/next-app` or `MobileLiveContract`; jobs stay in UserDefaults.
- Existing Phase 1 payloads (schema 3, no `size`/`actionVerb`) must load unchanged; do not bump `LoadProfileStore.schemaVersion`.
- A job's size applies to custom jobs only. Existing custom jobs (e.g. the seeded "Bake bread") have no size and keep exact kWh/hours editing.
- Template and job copy follows `docs/voice-and-terms.md` (never bare "job"; "Add a Job", "Add a Custom Job"-style names).
- `./cmd/ios-app/lint.sh` clean (SwiftFormat + SwiftLint `--strict`), zero compiler warnings, no `swiftlint:disable`; files ≤ 400 lines, type bodies ≤ 350 (split into `+Feature.swift` files).
- Tests: `./cmd/ios-app/run-tests.sh --quick <SuiteName>` while iterating; plain `./cmd/ios-app/run-tests.sh` before handoff (cap with `PWUSAGE_TEST_TIMEOUT_SECONDS`). TDD: failing test first.
- Dynamic Type accessibility sizes and VoiceOver must work for new views.

## Review Focus

1. **Phase 1 payload round trip** — a schema-3 payload without `size`/`actionVerb` loads with both nil and every job unchanged (Task 1).
2. **Size on a non-custom job** — rejected by validation; a custom job without a size stays valid (Task 1).
3. **Picking a size vs. hand-tuning** — choosing a size resets energy and hours to that size's defaults; stepping energy or hours afterwards never changes the size (Task 3).
4. **Blank or whitespace `actionVerb`** — falls back to the kind-based verb ("Charge" for cars, "Start" otherwise), never an empty action word (Task 2).
5. **Read-only charge source** — the quick sheet shows the source's value, disables both sliders and ±5 buttons, and never writes to the store (Task 4).
6. **Template picker with no jobs and with repeats** — adding from the empty state works; adding the same template twice yields two independent jobs (Task 2).

---

## File Structure

- Modify `PWUsage/Models/LoadTiming/LoadProfile.swift`: `JobSize`, new optional fields.
- Create `PWUsage/Models/LoadTiming/JobTemplates.swift`: the template list.
- Create `PWUsage/Models/LoadTiming/CarChargeSource.swift`: protocol and manual implementation.
- Modify `PWUsage/State/LoadTiming/LoadProfileStore.swift` (+ `LoadProfileStore+Creation.swift` if size limits bite): `addProfile`.
- Modify `PWUsage/Views/LoadTiming/ProfileDraft.swift`, `ProfileEditorSheet.swift`, `LoadProfilesSheet.swift`, `CarQuickEditSheet.swift`, `SmartShiftPresentation+Context.swift`.
- Create `PWUsage/Views/LoadTiming/JobTemplatePicker.swift`.
- Tests: extend `LoadProfileStoreTests+Cars.swift`/add `LoadProfileStoreTests+Templates.swift`, `ProfileDraftTests.swift`, `SmartShiftPresentationTests+Verb.swift`; new `JobTemplatesTests.swift`, `CarChargeSourceTests.swift`.

---

### Task 1: Size and verb on the job model; one creation path

**Files:**
- Modify: `PWUsage/Models/LoadTiming/LoadProfile.swift`, `PWUsage/State/LoadTiming/LoadProfileStore.swift`
- Test: `PWUsageTests/LoadProfileStoreTests+Templates.swift` (create)

**Interfaces:**
- Produces:
  - `enum JobSize: String, Codable, CaseIterable, Equatable { case small, medium, large }` with `var title: String` ("Small"/"Medium"/"Large"), `var defaultEnergyKwh: Double` (1.5 / 6 / 20), `var energyStepKwh: Double` (0.5 / 1 / 5), `var defaultDurationHours: Double` (1 / 2 / 4).
  - `LoadProfile` gains `var size: JobSize?` and `var actionVerb: String?` (both default nil in the memberwise init, so existing call sites compile).
  - `@discardableResult func addProfile(name: String, kind: LoadProfileKind, energyKwh: Double, durationHours: Double, carSettings: CarLoadSettings?, size: JobSize?, actionVerb: String?) throws -> LoadProfile` — UUID id, trimmed name, appended, persisted; `createCustomProfile` and `createCarProfile` call it.
  - `validate` rejects `size != nil` unless `kind == .custom`, and trims `actionVerb` (empty → stored as nil).
- Consumes: Phase 1 store (`validate`, `persist`).

- [ ] **Step 1: Write failing tests** in `LoadProfileStoreTests+Templates.swift`: `sizesHaveTheSpecifiedDefaults` (small 1.5 kWh/step 0.5/1 h, medium 6/1/2, large 20/5/4), `addProfileStoresSizeAndVerb` (custom, `.large`, verb `"Heat"`; survives a reopen), `addProfileRejectsSizeOnNonCustomJobs` (appliance with `.small` throws `.invalidProfile`), `blankVerbIsStoredAsNil` (`"  "` → nil), `phaseOnePayloadLoadsWithNoSizeOrVerb` (a v3 JSON payload with no `size`/`actionVerb` keys: `profiles` equal, both fields nil), `customJobWithoutSizeStaysValid` (the seeded `custom-example` has `size == nil`).
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick LoadProfileStoreTests`. Expected: FAIL (compile errors).
- [ ] **Step 3: Implement** `JobSize`, the two fields and `addProfile` in `LoadProfile.swift` / `LoadProfileStore.swift`; refactor the two `create…` methods onto `addProfile`.
- [ ] **Step 4: Run** the same command and `./cmd/ios-app/lint.sh`. Expected: PASS, lint clean.
- [ ] **Step 5: Commit** `feat(ios): job size and action verb on the job model`.

---

### Task 2: Templates, the picker and the verb

**Files:**
- Create: `PWUsage/Models/LoadTiming/JobTemplates.swift`, `PWUsage/Views/LoadTiming/JobTemplatePicker.swift`
- Modify: `PWUsage/Views/LoadTiming/ProfileDraft.swift`, `LoadProfilesSheet.swift`, `SmartShiftPresentation+Context.swift`
- Test: `PWUsageTests/JobTemplatesTests.swift` (create), `PWUsageTests/ProfileDraftTests.swift`, `PWUsageTests/SmartShiftPresentationTests+Verb.swift`

**Interfaces:**
- Produces:
  - `struct JobTemplate: Identifiable, Equatable { let id: String; let title: String; let subtitle: String; let symbol: String; let draft: ProfileDraft }` and `enum JobTemplates { static let all: [JobTemplate] }` in this order: `ev` "Electric car" (the `ProfileDraft.newCar()` values), `dishwasher` "Wash the dishes" (5 kWh, 2 h, verb "Wash"), `washer` "Wash the laundry" (2 kWh, 1.5 h, "Wash"), `dryer` "Dry the laundry" (3 kWh, 1 h, "Dry"), `washer-dryer-combo` "Wash and dry the laundry" (8 kWh, 3 h, "Wash"), `custom` "Custom job" (medium size defaults, verb nil). Appliance drafts use `kind == .appliance`.
  - `ProfileDraft` gains `var size: JobSize?` and `var actionVerb: String?` (carried into `addProfile` and `editProfile`); `LoadProfilesSheet.save` creates every new job through `store.addProfile`.
  - `SmartShiftPresentation.Context.verb`: a non-blank trimmed `profile.actionVerb` wins; otherwise the Phase 1 rule (cars "Charge"; appliances keep "Wash"/"Dry" first words; else "Start").
  - `struct JobTemplatePicker: View` listing `JobTemplates.all`; choosing one calls `onChoose: (ProfileDraft) -> Void`.
- Consumes: Task 1 (`addProfile`, `size`, `actionVerb`).

- [ ] **Step 1: Write failing tests:** `JobTemplatesTests`: `listsTheSixTemplatesInOrder` (ids above), `everyTemplateDraftIsValid`, `applianceTemplatesCarryTheirVerbs` (dishwasher "Wash", dryer "Dry"), `customTemplateStartsMedium` (`size == .medium`, energy 6, duration 2). Store (`+Templates` file): `addingTheSameTemplateTwiceMakesTwoJobs` (two distinct UUID ids, both persisted), `addsFromEmptyStore` (delete all jobs, add the EV template, one job). `SmartShiftPresentationTests+Verb`: `explicitVerbWins` ("Heat" on a custom job → title "Heat now"), `blankVerbFallsBack` (`"  "` on a car → "Charge now").
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick JobTemplatesTests LoadProfileStoreTests SmartShiftPresentationTests ProfileDraftTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the templates, draft fields, `Context.verb`, and the picker. In `LoadProfilesSheet`, replace the "Add a Car" and "Add a Custom Job" buttons with one "Add a Job" button that presents `JobTemplatePicker`; choosing a template opens the existing editor sheet on its draft. The Smart Shift empty state's "Add a Job" button keeps opening Manage Jobs.
- [ ] **Step 4: Run** the same command and `./cmd/ios-app/lint.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): add jobs from templates`.

---

### Task 3: Small / Medium / Large custom jobs in the editor

**Files:**
- Modify: `PWUsage/Views/LoadTiming/ProfileDraft.swift`, `ProfileEditorSheet.swift`
- Test: `PWUsageTests/ProfileDraftTests.swift`

**Interfaces:**
- Produces: `ProfileDraft.applying(size: JobSize) -> ProfileDraft` (sets `size`, `energyKwh = size.defaultEnergyKwh`, `durationHours = size.defaultDurationHours`); `var energyStepKwh: Double` (`size?.energyStepKwh ?? 0.5`); the editor shows a segmented Size picker (Small/Medium/Large) above the estimate for custom jobs that have a size, and the Energy stepper uses `draft.energyStepKwh`. Custom jobs with `size == nil` keep today's 0.5 steppers and get no picker.
- Consumes: Tasks 1–2.

- [ ] **Step 1: Write failing tests** in `ProfileDraftTests`: `applyingASizeResetsEnergyAndHours` (large → 20 kWh, 4 h; medium → 6, 2), `steppingEnergyNeverChangesSize` (a medium draft with energy edited to 9 still has `size == .medium`), `stepFollowsSize` (small 0.5, medium 1, large 5, nil 0.5), `changingSizeIsAnUnsavedChange`.
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick ProfileDraftTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `applying(size:)`, `energyStepKwh`, and the picker/stepper wiring in `ProfileEditorSheet` (extract the estimate section into a subview to keep the body small).
- [ ] **Step 4: Run** the same command and `./cmd/ios-app/lint.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): Small, Medium and Large custom jobs`.

---

### Task 4: The charge-source seam

**Files:**
- Create: `PWUsage/Models/LoadTiming/CarChargeSource.swift`
- Modify: `PWUsage/State/LoadTiming/LoadProfileStore.swift`, `PWUsage/Views/LoadTiming/CarQuickEditSheet.swift`
- Test: `PWUsageTests/CarChargeSourceTests.swift` (create)

**Interfaces:**
- Produces: `protocol CarChargeSource { var isManual: Bool { get }; func currentCharge(for car: LoadProfile) -> Double? }`; `struct ManualCarChargeSource: CarChargeSource` (`isManual == true`, returns `car.carSettings?.initialStateOfCharge`); `LoadProfileStore.init(userDefaults:chargeSource: any CarChargeSource = ManualCarChargeSource())` and `let chargeSource: any CarChargeSource` on the store. The quick sheet reads the displayed current charge from `store.chargeSource.currentCharge(for:)` (falling back to the saved value when it returns nil) and, when `!isManual`, disables both sliders and ±5 buttons and shows "Synced from your car" under the current-charge row; it never calls `updateCarCharge` in that mode. Nothing is persisted and no Tesla API is called.
- Consumes: Phase 1 `CarQuickEditSheet`, `LoadProfileStore`.

- [ ] **Step 1: Write failing tests** in `CarChargeSourceTests`: `manualSourceReadsTheSavedCharge` (car at 35 → 35; non-car job → nil), `manualSourceIsManual`, `storeDefaultsToTheManualSource` (`store.chargeSource.isManual`), `storeKeepsAnInjectedSource` (a stub read-only source returning 61 is the one `store.chargeSource` reports, `isManual == false`).
- [ ] **Step 2: Run** `./cmd/ios-app/run-tests.sh --quick CarChargeSourceTests`. Expected: FAIL.
- [ ] **Step 3: Implement** the protocol, the manual source, the store property/initializer parameter, and the sheet's read-only mode (extract a small `isEditable` computed property so the sheet body stays small).
- [ ] **Step 4: Run** `./cmd/ios-app/run-tests.sh` (full) and `./cmd/ios-app/lint.sh`. Expected: all pass, zero warnings.
- [ ] **Step 5: Verify in the simulator** (build and launch via the iOS simulator tool if device access is granted; otherwise say so in the wrap-up): add a job from each template, pick Small/Medium/Large and step energy, and confirm the quick sheet is unchanged for a manual source. Capture screenshots.
- [ ] **Step 6: Commit** `feat(ios): swappable car charge source`.

---

## Self-review notes

- Spec coverage: templates (Task 2), Small/Medium/Large with scaled steps (Tasks 1, 3), charge-source seam (Task 4), "starter definitions are data" (Task 2), exact kWh/hours stay editable (Tasks 2–3), Phase 1 migration safety (Task 1). The explicit verb is the follow-up recorded in the Phase 1 ledger.
- Names used across tasks: `JobSize`, `addProfile`, `JobTemplates.all`, `ProfileDraft.applying(size:)`, `energyStepKwh`, `CarChargeSource`, `ManualCarChargeSource`, `chargeSource`.
