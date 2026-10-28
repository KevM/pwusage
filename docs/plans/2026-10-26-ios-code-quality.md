# iOS Code Quality Campaign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the native iOS app easy to navigate and change: one obvious home per feature, one
reason to change per file, no dead declarations, and automated gates that stop the debt returning —
without changing product behavior.

**Architecture:** Keep the existing layers (`Views`, `State`, `Models`, `Networking`, `Navigation`,
`Authentication`, `Shared`, `PWUsageWidgets`) and split within them by feature. `ObservableObject`
and `@MainActor` state ownership stay unchanged. Shared UI primitives move under `Views/Shared`.
Each split moves declarations and makes only the access-level changes needed for cross-file
extensions; no logic is rewritten during a split.

**Tech Stack:** Swift 6, SwiftUI, WidgetKit, ActivityKit, Swift Testing, SwiftLint 0.65.1,
SwiftFormat 0.64.3, Periphery, XcodeGen.

---

Design: `docs/superpowers/specs/2026-10-26-ios-code-quality-design.md`.

Baseline on `main` at `6c309eb6`: `./run-tests.sh` passes 667 tests in 47 suites; SwiftLint reports
1,349 violations and 0 errors; the build has zero Swift compiler warnings.

## Execution rules

- Work in `/Users/kevm/github/pwusage/.worktrees/ios-code-quality` on
  `refactor/ios-code-quality`. Do not touch the main checkout's unrelated changes.
- One task is one verified commit. Mechanical formatting never shares a commit with a structural
  edit.
- Do not hand-edit `PWUsage.xcodeproj`. New files are picked up by XcodeGen through the existing
  path-based sources. Run `xcodegen generate` after adding or moving files when running a bare
  `xcodebuild`; `run-tests.sh` regenerates the project itself.
- Run tests only through `cd cmd/ios-app && ./run-tests.sh [target]`. Never invoke `xcodebuild test`.
- Keep `DEVELOPMENT_TEAM: 6HQGHHRK87` in `project.yml`.
- Preserve every user-facing string, API contract, persistence key, refresh cadence, and error path.
- Before each commit run, from the worktree root:
  ```bash
  swiftlint lint --strict --baseline .swiftlint-baseline.json
  swiftformat --lint cmd/ios-app
  ```
  After the baseline is removed, drop `--baseline`.
- Build with zero warnings after each task:
  ```bash
  cd cmd/ios-app
  xcodegen generate
  xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
  ```
- Run the targeted suite named in the task. Run the full `./run-tests.sh` at the end of every stage
  and before the final commit.
- Regenerate `.swiftlint-baseline.json` only in a commit that removes violations. Record the
  before/after count in the commit message. Never raise a budget.
- A declaration is deleted only when Periphery, a whole-tree symbol search, and the compiler agree.
  Update the matching `CODE_AUDIT.md` finding in the same commit.
- Access-level changes are allowed for cross-file extensions: promote only the members an extension
  file needs from `private`/`fileprivate` to `internal`. Do not make anything `public`.
- If a task needs a product decision or exposes a behavior difference, stop and ask.

---

## Stage 0 — Enforcement and mechanical cleanup

### Task 1: Add the pinned SwiftFormat configuration and wrapper

Files:
- Create `.swiftformat`
- Create `cmd/ios-app/format.sh`

1. Write `.swiftformat` with exactly:
   ```text
   --swift-version 6.0
   --max-width 120
   --indent 4
   --linebreaks lf
   --semicolons never
   --trailing-commas always
   --import-grouping alpha
   --disable all
   --enable blankLineAfterImports,blankLinesAtEndOfScope,blankLinesAtStartOfScope,consecutiveBlankLines,duplicateImports,elseOnSameLine,indent,linebreakAtEndOfFile,linebreaks,sortImports,spaceAroundBraces,spaceAroundOperators,spaceInsideBraces,trailingCommas,trailingSpace
   ```
   The explicit `--disable all`/`--enable` list is load-bearing: the default rule set rewrites 2,944
   locations, including statement bodies. This pass is limited to whitespace, imports, and commas.
2. Write `cmd/ios-app/format.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd "$(dirname "$0")/../.."
   swiftformat cmd/ios-app --config .swiftformat "$@"
   ```
   Make it executable with `chmod +x cmd/ios-app/format.sh`.
3. Run `swiftformat --lint cmd/ios-app --config .swiftformat` and record the count. Do not format
   yet.
4. Commit the config and wrapper.

### Task 2: Apply the imports/whitespace/comma pass

Files:
- Modify Swift files under `cmd/ios-app` (mechanical).

1. Run:
   ```bash
   swiftformat cmd/ios-app --config .swiftformat \
     --rules sortImports,duplicateImports,blankLineAfterImports,trailingCommas,trailingSpace,blankLinesAtEndOfScope,blankLinesAtStartOfScope,consecutiveBlankLines,linebreakAtEndOfFile,linebreaks,elseOnSameLine
   ```
   Do not include `indent` or any `wrap*` rule in this task.
2. Review `git diff --stat`; every change must be whitespace, import order, or a trailing comma.
3. Run `cd cmd/ios-app && ./run-tests.sh`.
4. Commit as a formatting-only change. Record the commit hash for Task 3.

### Task 3: Apply the indentation pass and start `.git-blame-ignore-revs`

Files:
- Modify Swift files under `cmd/ios-app` (mechanical).
- Create `.git-blame-ignore-revs`

1. Run `swiftformat cmd/ios-app --config .swiftformat --rules indent`. Do not include wrapping rules.
2. Review `git diff -w` to confirm only indentation changed; `git diff --stat` should still show
   the expected broad churn.
3. Run `cd cmd/ios-app && ./run-tests.sh`.
4. Commit the indentation-only change.
5. Create `.git-blame-ignore-revs` with a header, then append the two actual hashes:
   ```bash
   printf '# SwiftFormat mechanical passes. Use:\n# git config blame.ignoreRevsFile .git-blame-ignore-revs\n' \
     > .git-blame-ignore-revs
   git log -2 --reverse --format=%H >> .git-blame-ignore-revs
   ```
   Commit it separately.

### Task 4: Make SwiftFormat a blocking CI check

Files:
- Modify `.github/workflows/ios.yml`

1. Add `.swiftformat` and `cmd/ios-app/format.sh` to the workflow `paths` trigger.
2. Add a step before SwiftLint, using the repository root:
   ```yaml
   - name: SwiftFormat
     working-directory: .
     run: |
       if ! command -v swiftformat &> /dev/null; then
         HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install swiftformat
       fi
       swiftformat --lint cmd/ios-app --config .swiftformat
   ```
3. Run `swiftformat --lint cmd/ios-app --config .swiftformat` locally; it must be clean.
4. Commit.

### Task 5: Adopt the SwiftLint baseline and blocking gate

Files:
- Modify `.swiftlint.yml`
- Create `.swiftlint-baseline.json`
- Modify `.github/workflows/ios.yml`
- Modify `CODE_AUDIT.md` §14.4

1. Replace the header comments and limits in `.swiftlint.yml` with:
   ```yaml
   # SwiftLint for the iOS app. Run from the repository root:
   #   swiftlint lint --strict --baseline .swiftlint-baseline.json
   # Budgets are the campaign targets. The checked-in baseline records the debt
   # that predates them; regenerate it only when a PR lowers the count.
   included:
     - cmd/ios-app
   excluded:
     - cmd/ios-app/build
     - cmd/ios-app/PWUsage.xcodeproj
     - cmd/ios-app/.build
   opt_in_rules:
     - sorted_imports
     - empty_count
     - force_unwrapping
     - unhandled_throwing_task
   line_length:
     warning: 120
   file_length:
     warning: 400
     error: 500
   type_body_length:
     warning: 350
     error: 450
   function_body_length:
     warning: 50
     error: 100
   cyclomatic_complexity:
     warning: 10
     error: 20
   nesting:
     type_level: 1
     function_level: 2
   large_tuple:
     warning: 2
     error: 3
   function_parameter_count:
     warning: 5
     error: 8
   ```
2. Run `swiftlint lint --strict --write-baseline .swiftlint-baseline.json`. Then run
   `swiftlint lint --strict --baseline .swiftlint-baseline.json`; it must report zero.
3. Record the new baseline count and per-rule counts in `CODE_AUDIT.md` §14.4, replacing the stale
   1,413 figure.
4. In `.github/workflows/ios.yml`, remove `continue-on-error: true` and run:
   ```bash
   swiftlint lint --strict --baseline .swiftlint-baseline.json \
     --reporter github-actions-logging
   ```
5. Commit. CI now fails on any violation not in the baseline.

### Task 6: Add Periphery discovery without gating

Files:
- Create `cmd/ios-app/.periphery.yml`
- Create `cmd/ios-app/periphery.sh`
- Modify `CODE_AUDIT.md` §9 with confirmed dead declarations

1. Install Periphery locally with `brew install periphery`.
2. Write `cmd/ios-app/.periphery.yml`:
   ```yaml
   project:
     project: PWUsage.xcodeproj
     schemes:
       - PWUsage
     targets:
       - PWUsage
       - PWUsageWidgets
   retain_public: true
   retain_objc_accessible: true
   ```
3. Write `cmd/ios-app/periphery.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd "$(dirname "$0")"
   if ! command -v periphery >/dev/null 2>&1; then
     echo "Periphery is not installed. Run: brew install periphery" >&2
     exit 127
   fi
   xcodegen generate
   xcodebuild -project PWUsage.xcodeproj -scheme PWUsage \
     -destination 'generic/platform=iOS Simulator' \
     CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=YES build
   periphery scan --config .periphery.yml --format xcode
   ```
   Make it executable. If Periphery needs an explicit index-store path, resolve it from
   `xcodebuild -showBuildSettings` and record the working invocation in `ARCHITECTURE.md` during
   Task 7.
4. Run `cmd/ios-app/periphery.sh` and triage every result: `#Preview`, `@main`, WidgetBundle,
   Widget/ControlWidget, ActivityKit, and App Intent entry points are expected dynamic entries.
   Do not delete anything in this task.
5. Record confirmed candidates under §9.1–§9.6 in `CODE_AUDIT.md`; leave the raw report untracked.
6. Commit the config, script, and audit update.

### Task 7: Write the architecture map

Files:
- Create `cmd/ios-app/ARCHITECTURE.md`

1. Document the folder contract: `App/`, `Navigation/`, `Views/<Feature>/`, `Views/Shared/`,
   `State/<Feature>/`, `Models/<Feature>/`, `Networking/`, `Authentication/`, `Shared/`,
   `PWUsageWidgets/`, and `PWUsageTests/<Feature>/` plus `PWUsageTests/Support/`.
2. State the ownership rule: a file belongs to the feature whose screen or lifecycle consumes it;
   cross-target code lives in `Shared`; `Models` holds value types only.
3. List the supported dynamic entry points: `PWUsageApp`, `TodayEnergyWidgetBundle`, Widget and
   ControlWidget conformances, `BatteryHoldLiveActivity`, `BatteryHoldActivityAttributes`, App
   Intents, `UIViewControllerRepresentable` delegates, `#Preview`, and Codable synthesised members.
4. Record the budgets from Task 5 and the baseline regeneration rule.
5. Record how to run the app, tests, SwiftFormat, SwiftLint, and Periphery.
6. Commit.

**Stage 0 exit check:** run `./run-tests.sh`, SwiftFormat lint, and SwiftLint with the baseline from
the worktree root. All must pass.

---

## Stage 1 — Foundation

### Task 8: Extract the shared card and small shared states

Files:
- Create `PWUsage/Views/Shared/card-container.swift`
- Move `PWUsage/Views/SectionTheme.swift` → `PWUsage/Views/Shared/section-theme.swift`
- Move `PWUsage/Views/portable-modifiers.swift` → `PWUsage/Views/Shared/portable-modifiers.swift`
- Move `PWUsage/Views/clipboard.swift` → `PWUsage/Views/Shared/clipboard.swift`
- Create `PWUsage/Views/Shared/availability-banner.swift`
- Create `PWUsage/Views/Shared/empty-card.swift`
- Create `PWUsage/Views/Shared/loading-card.swift`
- Modify `PWUsage/Views/DashboardView.swift`, `PWUsage/Views/BillView.swift`,
  `PWUsage/Views/LoadTimingView.swift`

1. Implement one `CardContainer<Content: View>` that preserves the existing visual values through
   parameters: optional title/symbol, optional `SectionTheme`, padding, corner radius,
   `fillsWidth`, `fillsHeight`, fill alignment, and optional hairline border. Its default is the
   Bill/Load card: 13-point content spacing, 17-point padding, 20-point corner radius.
2. Make `StatusCard` in `DashboardView` a thin wrapper that supplies padding 16, corner 22, the
   existing `dashboardCardsFillHeight` environment value, and the border. Replace
   `BillInformationCard` and `LoadTimingCard` with direct `CardContainer` calls and delete both
   private types.
3. Move `AvailabilityBanner`, `EmptyCard`, and `LoadingCard` into `Views/Shared` unchanged except
   for file placement. Keep `DischargeSymbol` in the Home view for now.
4. Build and visually compare Home, Bill, and Load Timing in the simulator previews at normal and
   accessibility text sizes. There must be no spacing, border, or background change.
5. Run `./run-tests.sh DashboardPresentationTests`, `./run-tests.sh LoadTimingPresentationTests`,
   then the full suite.
6. Update `CODE_AUDIT.md` §9.10 to FIXED and commit.

### Task 9: Split the app shell

Files:
- Delete `PWUsage/PWUsageApp.swift`
- Create `PWUsage/App/pwusage-app.swift` (`PWUsageApp`, `Launch`)
- Create `PWUsage/App/pwusage-application-api.swift`
- Create `PWUsage/App/pwusage-commands.swift` (`PWUsageCommands`)
- Create `PWUsage/App/pwusage-app-model.swift` (`PWUsageAppModel`)
- Create `PWUsage/App/pwusage-root-view.swift` (`PWUsageRootView`)
- Create `PWUsage/Views/Shared/empty-state-screen.swift` (`EmptyStateScreen`)

1. Move declarations by name, not by line number. Keep every method and property verbatim.
2. Split the 480-line `PWUsageAppModel` into a base file plus feature extensions:
   - `pwusage-app-model.swift`: stored state, initializers, tab selection, and shared helpers.
   - `pwusage-app-model-authentication.swift`: launch, sign-in, sign-out, session invalidation.
   - `pwusage-app-model-sites.swift`: site selection, picker state, external navigation.
   - `pwusage-app-model-refresh.swift`: dashboard refresh and scene-phase forwarding.
   Promote only the members those extensions need from `private` to `internal`.
3. Keep `AppTabView` and `app-tab-view.swift` unchanged.
4. Run `./run-tests.sh PWUsageAppModelTests`, `./run-tests.sh AppTabTests`,
   `./run-tests.sh AppLaunchMaintenanceTests`, then the full suite.
5. Confirm `project.yml` is untouched and the generated app launches with a restored session.
6. Commit. Update `CODE_AUDIT.md` §9.8 with the new app-shell sizes.

### Task 10: Extract shared contract decoding infrastructure

Files:
- Create `Shared/mobile-contract-decoder.swift`
- Modify `Shared/mobile-live-contract.swift`
- Review `Shared/app-configuration.swift` and `Shared/shared-web-session.swift` for cross-target
  ownership; leave them in `Shared` when both app and widget compile them.

1. Move `MobileContractDecoder`, `CodingUserInfoKey.pwusageCurrentDate`,
   `Decoder.injectedCurrentDate`, and the private `ISO8601DateFormatter.parse` extension to
   `mobile-contract-decoder.swift`. These are decoding policy, not part of the live response shape.
2. Leave every JSON key, validation rule, error case, and freshness comment unchanged. Keep the
   decoder single-use contract.
3. Run `./run-tests.sh MobileContractsTests`, `./run-tests.sh PWUsageAPITests`,
   `./run-tests.sh today-energy-widget-tests`, then the full suite. Build the widget target.
4. Commit.

**Stage 1 exit check:** full suite, zero build warnings, lint/format clean, simulator smoke test of
launch, sign-in, site picker, and all four tabs.

---

## Stage 2 — Home / Dashboard + Today's Energy

### Task 11: Split `DashboardView` by section

Files:
- Create `PWUsage/Views/Home/dashboard-view.swift`
- Create `PWUsage/Views/Home/dashboard-view-live.swift`
- Create `PWUsage/Views/Home/dashboard-view-today.swift`
- Create `PWUsage/Views/Home/dashboard-view-bill.swift`
- Create `PWUsage/Views/Home/dashboard-view-load-timing.swift`
- Create `PWUsage/Views/Home/live-power-flow-cards.swift`
- Create `PWUsage/Views/Home/power-flow-layout.swift`
- Create `PWUsage/Views/Home/dashboard-cards.swift` (`StatusCard` wrapper only)
- Create `PWUsage/Views/Home/discharge-symbol.swift`
- Move `PWUsage/Views/DashboardPreviews.swift` → `PWUsage/Views/Home/dashboard-previews.swift`

1. Move `DashboardView` and its private helpers by section. Keep `body`, shared state accessors, and
   layout selection in `dashboard-view.swift`.
2. Move `LivePowerFlowCards`, `FlowColumn`, `FlowRow`, and `PowerFlowLayout` to their own files.
   Move `DischargeSymbol` to its own file.
3. Keep `EnvironmentValues.dashboardCardsFillHeight` with the power-flow layout file.
4. Do not change view hierarchy order, spacing, animation identity, accessibility labels, or refresh
   callbacks. Promote only the members the extension files need from `private` to `internal`.
5. Run `./run-tests.sh DashboardPresentationTests`, `./run-tests.sh LivePowerFlowLayoutTests`,
   then the full suite. Smoke test Home in one- and two-column layouts.
6. Commit. Update `CODE_AUDIT.md` §9.9 with the split.

### Task 12: Split `DashboardCoordinator` by responsibility

Files:
- Create `PWUsage/Models/dashboard-contracts.swift` (API protocols, `DashboardEndpointState`,
  `DashboardSheet`, solar connection/enhancement state)
- Create `PWUsage/State/Home/dashboard-coordinator.swift` (state, init, lifecycle, site/auth)
- Create `PWUsage/State/Home/dashboard-coordinator-refresh.swift`
- Create `PWUsage/State/Home/dashboard-coordinator-load-timing.swift`
- Create `PWUsage/State/Home/dashboard-coordinator-solar.swift`
- Create `PWUsage/State/Home/dashboard-coordinator-battery-hold.swift`
- Move `PWUsage/State/DashboardCache.swift` → `PWUsage/State/Home/dashboard-cache.swift`
- Move `PWUsage/Views/DashboardPresentation.swift` → `PWUsage/Views/Home/dashboard-presentation.swift`

1. Move the coordinator's stored state and published properties to the base file. Move methods by
   lifecycle: refresh scheduling/timers/live/bill/power, load-timing/planning context, solar
   forecast, and battery hold. Keep generation checks and cancellation order unchanged.
2. Promote cross-file members from `private` to `internal`; do not add wrappers or new state.
3. Move the API protocols to `Models/dashboard-contracts.swift`; they are contracts, not UI state.
4. Run `./run-tests.sh DashboardCoordinatorTests`, `./run-tests.sh SolarForecastCoordinatorTests`,
   `./run-tests.sh battery-hold-coordinator-tests`, then the full suite.
5. Commit. Update `CODE_AUDIT.md` §9.8/§9.9 and mark any closed §9 items.

### Task 13: Clean Home dead code and finish Today's Energy boundaries

Files:
- Modify `PWUsage/Views/Home/*`
- Modify `Shared/today-energy-*.swift`
- Modify `PWUsageWidgets/today-energy-*.swift`
- Modify `CODE_AUDIT.md` §9

1. Delete declarations confirmed by Task 6 in the Home and Today's Energy trees. Start with the
   `DashboardPreviewAPI`/preview-only types that are not used by a preview.
2. Split `Shared/today-energy-presentation.swift` or widget files only if any exceeds 400 lines or
   mixes snapshot, presentation, and widget layout. Keep the App Group file format and keys
   identical.
3. Remove `lastError...` members only where the compiler, symbol search, and Periphery agree, and
   only if no UI path reads them. Remove the no-op `solarForecastSettingsDidEdit` and
   `loadProfileDidEdit` coordinator methods and their call sites, plus any coordinator state that is
   written but never read.
4. Run `./run-tests.sh today-energy-widget-tests`, `./run-tests.sh PreviewFixtureTests`, then the
   full suite. Build both app and widget targets.
5. Commit. Update every closed §9 finding (§9.4–§9.6) and the §9 summary table.

**Stage 2 exit check:** full suite; Home and widget screenshots at normal and accessibility sizes
match the pre-refactor rendering.

---

## Stage 3 — Load Timing + Smart Shift

### Task 14: Split the Load Timing screen and presentation

Files:
- Create `PWUsage/Views/LoadTiming/load-timing-view.swift`
- Create `PWUsage/Views/LoadTiming/load-timing-freshness-label.swift`
- Create `PWUsage/Views/LoadTiming/load-timing-presentation.swift` by extracting
  `LoadTimingPresentation` from `LoadTimingView.swift`
- Move `PWUsage/Views/LoadTimingForecastPresentation.swift` → `PWUsage/Views/LoadTiming/load-timing-forecast-presentation.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-details-view.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-cost-bars.swift`
- Move `PWUsage/Views/SmartShiftVerdictView.swift` → `PWUsage/Views/LoadTiming/smart-shift-verdict-view.swift`

1. Move the screen body, freshness label/announcement, and sheet views into the feature folder.
   Preserve accessibility labels, announcement timing, and refresh intents. If the screen still
   exceeds 400 lines, split its private sections into `load-timing-sections.swift`.
2. Split `LoadTimingForecastPresentation` by concern only if it exceeds 400 lines: forecast
   availability, axis/lane formatting, and per-period rows. Do not change formatting output.
3. Run `./run-tests.sh LoadTimingPresentationTests`, `./run-tests.sh LoadTimingEstimatorTests`,
   `./run-tests.sh DashboardPresentationTests`, then the full suite.
4. Commit. Update `CODE_AUDIT.md` §9.2 if `LoadTimingAffordance` is confirmed dead and removed.

### Task 15: Split `LoadTimingForecastEstimator`

Files:
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-estimator.swift` (namespace, constants,
  `Safety`, `RuledOut`, `UnavailableReason`, `PlanningSlot`, `PlanningContext`)
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-projection.swift` (`Projection`,
  `BalancePoint`, `BalanceLane`, `Comparison`, `Result`)
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-model.swift` (`WallClock`, `Flow`,
  `FlowModel`)
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-plan.swift` (`Plan`, `PlanState`,
  `Prepared`, `plan(now:timing:projection:balanceSourceTime:billingCycleEnd:currencyCode:)`)
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-evaluate.swift` (`evaluate`,
  `loadUnavailable`, candidate scoring)
- Create `PWUsage/Models/LoadTiming/load-timing-forecast-selection.swift` (`assess`, `Selection`,
  `select`, `balanceLanes`, `balanceSeries`)
- Create `PWUsage/Models/LoadTiming/array-partition-point.swift`
- Delete `PWUsage/Models/LoadTimingForecastEstimator.swift`

1. Move declarations verbatim. Keep the public entry points and result semantics identical.
2. Make `fileprivate`/`private` nested helpers `internal` only where a cross-file extension needs
   them. Do not add new abstractions.
3. Run `./run-tests.sh LoadTimingForecastEstimatorTests`, `./run-tests.sh SmartShiftPropertyTests`,
   `./run-tests.sh BillOutlookTests`, then the full suite.
4. Commit. Update `CODE_AUDIT.md` §9.1 if the dead estimator API is confirmed and removed.

### Task 16: Split Load Profiles and Smart Shift presentation

Files:
- Move `PWUsage/Models/LoadProfile.swift` → `PWUsage/Models/LoadTiming/load-profile.swift`
- Move `PWUsage/State/LoadProfileStore.swift` → `PWUsage/State/LoadTiming/load-profile-store.swift`
- Create `PWUsage/Views/LoadTiming/load-profiles-sheet.swift`
- Create `PWUsage/Views/LoadTiming/profile-draft.swift`
- Create `PWUsage/Views/LoadTiming/profile-editor-sheet.swift`
- Create `PWUsage/Views/LoadTiming/sheet-dismiss-attempt-observer.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-models.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-presentation.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-presentation-lanes.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-presentation-messages.swift`
- Create `PWUsage/Views/LoadTiming/smart-shift-context.swift`
- Keep `PWUsage/Models/SmartShiftDiagnostics.swift` as the model home.

1. Move `ProfileDraft`, `ProfileEditorSheet`, and `SheetDismissAttemptObserver` out of
   `LoadProfilesSheet.swift`; keep the sheet as composition only.
2. Move `ForecastAvailability`, `CostBar`, `SwitchMarker`, `LaneDisplay`, `SmartShiftVerdict`,
   `PeriodRow`, `CostLine`, `CostBreakdown`, `BetterJobHint`, `SmartShiftScreen`, and
   `SmartShiftEvaluation` to `smart-shift-models.swift`.
3. Split the presentation enum into core evaluation, lane/draw construction, messages, and the
   private `Context` type. Keep every message string byte-identical.
4. Update the `maximumCarCapacityKwh` comment to describe the actual end-of-tomorrow/billing-cycle
   horizon, and hoist the ad-hoc `250` ceiling in `LoadProfileStore` to a named constant. Do not
   change either value.
5. Run `./run-tests.sh SmartShiftPresentationTests`, `./run-tests.sh SmartShiftPropertyTests`,
   `./run-tests.sh SmartShiftDiagnosticsTests`, `./run-tests.sh ProfileDraftTests`, then the full
   suite.
6. Commit. Update `CODE_AUDIT.md` §9.2/§9.4/§9.8/§9.15.

### Task 17: Clean Load Timing dead code and close the feature

Files:
- Modify `PWUsage/Views/LoadTiming/*`, `PWUsage/State/LoadTiming/*`,
  `PWUsage/Models/LoadTiming/*`
- Modify `CODE_AUDIT.md` §9

1. Delete confirmed dead preview fixtures, unused `LoadTimingAffordance`, and unused diagnostics
   helpers. Keep dynamic previews listed in `ARCHITECTURE.md`.
2. Replace whole-file lint suppressions in this subtree with `:next` suppressions with reasons, or
   fix the violation. None should remain.
3. Run the full suite. Smoke test Load Timing at normal, stale, unavailable, and accessibility
   sizes.
4. Commit.

**Stage 3 exit check:** full suite; estimator/property tests unchanged in count; screen copy
unchanged.

---

## Stage 4 — Battery Saver

### Task 18: Group Battery Saver views, models, and state by feature

Files:
- Move `PWUsage/Views/battery-hold-*.swift` → `PWUsage/Views/BatteryHold/`
- Move `PWUsage/Models/battery-hold*.swift` → `PWUsage/Models/BatteryHold/`
- Move `PWUsage/State/battery-hold-*.swift` → `PWUsage/State/BatteryHold/`
- Move `Shared/battery-hold-*.swift` → `Shared/BatteryHold/`
- Move `PWUsageWidgets/battery-hold-*.swift` → `PWUsageWidgets/BatteryHold/`

1. Move files with `git mv`; do not rename types or user-facing copy. Product copy remains
   "Battery Saver"; internal `BatteryHold` names stay to keep this task behavior-only.
2. Let XcodeGen pick up the new folders. Do not edit `project.yml`.
3. Run `./run-tests.sh battery-hold-tests`, `./run-tests.sh battery-hold-coordinator-tests`,
   `./run-tests.sh battery-hold-activity-contract-tests`, then the full suite. Build app and widget.
4. Commit.

### Task 19: Split `BatteryHoldActivityCoordinator`

Files:
- Create `PWUsage/State/BatteryHold/battery-hold-activity-contracts.swift`
- Create `PWUsage/State/BatteryHold/battery-hold-activity-registration-store.swift`
- Create `PWUsage/State/BatteryHold/battery-hold-activity-coordinator.swift`
- Create `PWUsage/State/BatteryHold/battery-hold-activity-coordinator-session.swift`
- Create `PWUsage/State/BatteryHold/battery-hold-activity-coordinator-tracking.swift`
- Create `PWUsage/State/BatteryHold/battery-hold-activity-coordinator-registration.swift`

1. Move the coordinator class and stored state into the base file, then extract the listed
   extensions from the original combined file. Move APNs/registration/activity protocols and offer
   types to contracts, and the UserDefaults registration store to its own file.
2. Split the coordinator into session lifecycle, activity tracking, and push registration/reconcile
   extensions. Keep operation ordering, cancellation, and timeout semantics identical.
3. Promote only cross-file members to `internal`.
4. Run `./run-tests.sh battery-hold-activity-coordinator-tests`,
   `./run-tests.sh battery-hold-activity-render-tests`, then the full suite.
5. Commit. Update `CODE_AUDIT.md` §9.8.

### Task 20: Split shared Live Activity views and finish Battery Saver cleanup

Files:
- Modify `Shared/BatteryHold/battery-hold-activity-views.swift`
- Modify `Shared/BatteryHold/battery-hold-activity-attributes.swift`
- Modify `Shared/BatteryHold/battery-hold-activity-presentation.swift`
- Modify `PWUsageWidgets/BatteryHold/battery-hold-live-activity.swift`
- Modify `PWUsageWidgets/BatteryHold/battery-hold-control.swift`
- Modify `CODE_AUDIT.md` §9

1. Split the active, ended, and compact Live Activity views into separate files if the combined
   file exceeds 400 lines or owns more than one lifecycle. Keep the ActivityKit attributes and
   content-state encoding unchanged.
2. Delete preview-only APIs and dead presentation helpers confirmed by Periphery and symbol search,
   except dynamic widget/control entry points.
3. Run `./run-tests.sh battery-hold-preview-tests`,
   `./run-tests.sh battery-hold-activity-presentation-tests`, then the full suite. Install the
   widget on the simulator and check the Live Activity and control.
4. Commit.

**Stage 4 exit check:** full suite; Live Activity rendering tests pass; no App Group key changed.

---

## Stage 5 — Solar Forecast

### Task 21: Split `SolarForecastStore`

Files:
- Create `PWUsage/Models/Solar/solar-forecast-store-models.swift` (clock, credential, batch,
  budget, persisted state, persistence/managing protocols, refresh failure/result)
- Create `PWUsage/State/Solar/solar-forecast-store.swift` (actor state, init, credential/cache
  reads)
- Create `PWUsage/State/Solar/solar-forecast-store-discovery.swift`
- Create `PWUsage/State/Solar/solar-forecast-store-refresh.swift`
- Create `PWUsage/State/Solar/solar-forecast-store-budget.swift`
- Create `PWUsage/State/Solar/solar-forecast-store-persistence.swift`
- Create `PWUsage/State/Solar/solar-forecast-store-mutations.swift`
- Create `PWUsage/State/Solar/device-solar-forecast-persistence.swift`
- Delete `PWUsage/State/SolarForecastStore.swift`

1. Move declarations verbatim. Keep every JSON key, file name, keychain service, budget rule, and
   error mapping unchanged.
2. Split the actor into extensions by discovery, refresh/failure persistence, budget/refund,
   persistence/retry, and mutation generation. Promote cross-file members to `internal`.
3. Move `DeviceSolarForecastPersistence` and `SolarForecastStoreSessionCleanup` to their own file.
4. Run `./run-tests.sh SolarForecastStoreTests`,
   `./run-tests.sh SolarForecastCoordinatorTests`, then the full suite.
5. Commit. Update `CODE_AUDIT.md` §9.8.

### Task 22: Split Solar forecast models, networking, and UI

Files:
- Move `PWUsage/Models/SolarForecast.swift` → `PWUsage/Models/Solar/solar-forecast.swift`
- Move `PWUsage/Networking/SolcastClient.swift` → `PWUsage/Networking/Solar/solcast-client.swift`
- Create `PWUsage/Networking/Solar/solcast-transport.swift` if the URLSession transport and
  redirect delegate should not live with the client
- Move `PWUsage/Views/SolarForecastSettingsSheet.swift` → `PWUsage/Views/Solar/solar-forecast-settings-sheet.swift`
- Move `PWUsage/Views/SolarForecastSettingsStatus.swift` → `PWUsage/Views/Solar/solar-forecast-settings-status.swift`
- Move `PWUsage/Views/SolarForecastPreviews.swift` → `PWUsage/Views/Solar/solar-forecast-previews.swift`
- Create `PWUsage/Views/Solar/smart-shift-preview-fixtures.swift` if preview fixtures are shared

1. Move files first; split only where a file exceeds 400 lines or mixes model, networking, and
   presentation. Keep Solcast URL paths, headers, retry-after parsing, and timestamp decoding
   identical.
2. Split `SolarForecastPreviews` from `SmartShiftPreviewFixture` if both are in the same file.
3. Run `./run-tests.sh SolarForecastTests`, `./run-tests.sh SolcastClientTests`,
   `./run-tests.sh SolcastCaptureTests`, `./run-tests.sh SolarForecastArraySelectionTests`,
   `./run-tests.sh SolarForecastSettingsStatusTests`, then the full suite.
4. Commit. Update `CODE_AUDIT.md` §9.5/§9.6 if dead preview helpers are removed.

### Task 23: Close Solar dead code and lint

Files:
- Modify `PWUsage/Models/Solar/*`, `PWUsage/State/Solar/*`, `PWUsage/Networking/Solar/*`,
  `PWUsage/Views/Solar/*`
- Modify `CODE_AUDIT.md` §9

1. Remove confirmed dead helpers and preview-only API types. Keep dynamic Solcast/Widget entry
   points.
2. Consolidate `SolarForecast.combine`'s duplicated per-point validation and double processing
   (§9.11) after adding or confirming tests for accepted/rejected points, ordering, and DST. The
   accepted output and timestamps must stay identical.
3. Fix every SwiftLint violation in this subtree, including line length, without changing copy or
   behavior.
4. Run the full suite. Smoke test settings connect/disconnect and Smart Shift with/without solar.
5. Commit. Update `CODE_AUDIT.md` §9.5/§9.6/§9.11.

**Stage 5 exit check:** full suite; credentials still survive relaunch; budget behavior unchanged.

---

## Stage 6 — Bill, Tariff, Auth, Settings, and Sites

### Task 24: Split Bill and Tariff by feature

Files:
- Move `PWUsage/Views/BillView.swift` → `PWUsage/Views/Bill/bill-view.swift`
- Move `PWUsage/Views/BillOutlookPresentation.swift` → `PWUsage/Views/Bill/bill-outlook-presentation.swift`
- Move `PWUsage/Models/BillOutlook.swift` → `PWUsage/Models/Bill/bill-outlook.swift`
- Move `PWUsage/Models/MobileTariffs.swift` → `PWUsage/Models/Bill/mobile-tariffs.swift`
- Move `PWUsage/Views/TariffSheet.swift` → `PWUsage/Views/Bill/tariff-sheet.swift`
- Create `PWUsage/Views/Bill/bill-period-rows.swift` if the periods section still needs extraction
- Modify `CODE_AUDIT.md` §9

1. Move files and split bill sections only if the screen exceeds 400 lines or mixes cycle summary,
   periods, and outlook. Keep currency, tariff period ordering, and accessibility labels identical.
2. Remove preview-only bill APIs confirmed dead.
3. Run `./run-tests.sh BillOutlookTests`, `./run-tests.sh BillOutlookPresentationTests`,
   `./run-tests.sh TariffSheetTests`, then the full suite.
4. Commit.

### Task 25: Split auth, settings, and site selection

Files:
- Create `PWUsage/Authentication/mobile-auth-service.swift`
- Create `PWUsage/Authentication/mobile-auth-service-sign-in.swift`
- Create `PWUsage/Authentication/mobile-auth-service-session.swift`
- Create `PWUsage/Authentication/mobile-auth-pkce.swift`
- Move `PWUsage/Views/SignInView.swift` → `PWUsage/Views/Auth/sign-in-view.swift`
- Move `PWUsage/Views/settings-view.swift` → `PWUsage/Views/Settings/settings-view.swift`
- Move `PWUsage/Views/about-sheet.swift` → `PWUsage/Views/Settings/about-sheet.swift`
- Move `PWUsage/Views/SitePickerView.swift` → `PWUsage/Views/Sites/site-picker-view.swift`
- Move `PWUsage/Views/tesla-reconnect-action.swift` → `PWUsage/Views/Settings/tesla-reconnect-action.swift`
- Move `PWUsage/Navigation/app-tab.swift` and `app-tab-view.swift` under `PWUsage/Navigation/`
  (already there; keep names)

1. Move `MobileAuthService` and its protocols out of `PWUsage/Authentication/MobileAuthService.swift`
   into the new base file, then split PKCE/URL construction, sign-in continuation, and session/cookie
   handling into extensions. Delete the original file after the move. Keep the callback scheme,
   cookie names, and continuation behavior identical.
2. Keep settings and site picker as composition; move them into feature folders without renaming
   user-facing labels.
3. Run `./run-tests.sh MobileAuthServiceTests`, `./run-tests.sh sign-in-render-tests`,
   `./run-tests.sh AppTabTests`, then the full suite.
4. Commit. Update `CODE_AUDIT.md` §9.5/§9.6 if dead preview helpers are removed.

**Stage 6 exit check:** full suite; sign-in, sign-out, site switch, rate plan, and reconnect flows
smoke-tested.

---

## Stage 7 — Tests

### Task 26: Extract shared test doubles

Files:
- Create `PWUsageTests/Support/mobile-dashboard-data-api-spy.swift`
- Create `PWUsageTests/Support/mobile-load-planning-data-api-spy.swift`
- Create `PWUsageTests/Support/application-api-spy.swift`
- Create `PWUsageTests/Support/mobile-auth-web-session-fake.swift`
- Create `PWUsageTests/Support/test-clocks.swift`
- Modify `PWUsageTests/PWUsageAppModelTests.swift`,
  `PWUsageTests/DashboardCoordinatorTests.swift`,
  `PWUsageTests/SolarForecastCoordinatorTests.swift`,
  `PWUsageTests/SolarForecastStoreTests.swift`

1. Move the duplicated `ApplicationAPISpy`, `DashboardAPISpy`, `ForecastDashboardAPISpy`, auth
   web-session fake, and test clocks to `Support/`. Provide one configurable double per protocol,
   not per test file.
2. Keep the doubles `@MainActor` where the existing ones are; preserve request recording and
   failure injection semantics.
3. Run the affected suites individually, then the full suite. Test count and behavior must not
   change.
4. Commit. Update `CODE_AUDIT.md` §9.14.

### Task 27: Split oversized test files by feature

Files:
- Move `PWUsageTests/PWUsageAppModelTests.swift` → `PWUsageTests/App/pwusage-app-model-tests.swift`;
  add `pwusage-app-model-authentication-tests.swift`, `pwusage-app-model-sites-tests.swift`, and
  `pwusage-app-model-refresh-tests.swift`
- Move `PWUsageTests/LoadTimingForecastEstimatorTests.swift` →
  `PWUsageTests/LoadTiming/load-timing-forecast-estimator-tests.swift`; add
  `load-timing-forecast-estimator-projection-tests.swift`,
  `load-timing-forecast-estimator-safety-tests.swift`,
  `load-timing-forecast-estimator-selection-tests.swift`, and
  `load-timing-forecast-estimator-validation-tests.swift`
- Move `PWUsageTests/SolarForecastStoreTests.swift` →
  `PWUsageTests/Solar/solar-forecast-store-tests.swift`; add
  `solar-forecast-store-credentials-tests.swift`, `solar-forecast-store-refresh-tests.swift`,
  `solar-forecast-store-budget-tests.swift`, and `solar-forecast-store-persistence-tests.swift`
- Move `PWUsageTests/SolarForecastCoordinatorTests.swift` →
  `PWUsageTests/Solar/solar-forecast-coordinator-tests.swift`; add
  `solar-forecast-coordinator-refresh-tests.swift`, `solar-forecast-coordinator-settings-tests.swift`,
  and `solar-forecast-coordinator-failure-tests.swift`
- Move `PWUsageTests/DashboardCoordinatorTests.swift` →
  `PWUsageTests/Home/dashboard-coordinator-tests.swift`; add
  `dashboard-coordinator-refresh-tests.swift`, `dashboard-coordinator-battery-hold-tests.swift`, and
  `dashboard-coordinator-load-timing-tests.swift`
- Move `PWUsageTests/SmartShiftPresentationTests.swift` →
  `PWUsageTests/LoadTiming/smart-shift-presentation-tests.swift`; add
  `smart-shift-presentation-costs-tests.swift`, `smart-shift-presentation-messages-tests.swift`, and
  `smart-shift-presentation-lanes-tests.swift`

1. Keep the existing `@Suite` declaration in the first file and add the other fragments as
   `extension <SuiteName> { ... }`. This preserves the suite name and `.serialized` trait, so
   splitting a file does not turn one serialized suite into several parallel suites.
2. Split by `@Test` concern. Move helpers to `Support/` or make them `internal` so extensions can
   use them. No test may be deleted or weakened.
3. Use `git mv` for the first fragment so history follows the largest group.
4. Run each new suite individually, then the full suite. Confirm the test count matches the baseline
   (667) unless a duplicate helper test was deliberately deduplicated.
5. Commit. Update `CODE_AUDIT.md` §9.14/§9.15.

### Task 28: Rename misnamed suites and pin the remaining ambient clock

Files:
- Rename `PWUsageTests/LoadTimingViewTests.swift` →
  `PWUsageTests/LoadTiming/load-timing-presentation-tests.swift`
- Modify `PWUsageTests/battery-hold-activity-render-tests.swift`
- Modify `PWUsageTests/Support/test-clocks.swift` if a shared UTC clock belongs there

1. The suite already says "Load Timing Presentation Tests"; rename the file to match.
2. Replace `TimeZone.current.identifier` in the render test with a fixed UTC identifier so the test
   does not depend on the simulator's region.
3. Audit tests for `Locale.current`; every formatting assertion must pass an explicit `Locale` with
   a known identifier. Check `today-energy-widget-tests` and presentation tests.
4. Run the renamed suite and the render suite, then the full suite.
5. Commit. Update `CODE_AUDIT.md` §9.12/§9.13.

**Stage 7 exit check:** full suite; 667 tests (or the documented deduplicated count) pass; no fixed
sleep assertions.

---

## Stage 8 — Final ratchet and removal of the baseline

### Task 29: Burn the remaining SwiftLint rules by family

Files:
- Modify Swift files reported by SwiftLint
- Modify `.swiftlint-baseline.json` only when the total falls

1. Run `swiftlint lint --strict --reporter json > /tmp/swiftlint.json` and group by rule. Work one
   rule family per commit:
   - `force_unwrapping`, `force_try`: use `guard let`/`#require` in tests and explicit error
     handling in production.
   - `identifier_name`: rename to meaningful names; add an `allowed_symbols` entry only for a
     project-wide convention, never a file suppression.
   - `implicit_optional_initialization`, `statement_position`, `vertical_whitespace`,
     `redundant_discardable_let`, `control_statement`: fix or let `swiftlint --fix` apply.
   - `function_parameter_count`: introduce parameter objects or split the function.
   - `cyclomatic_complexity`, `function_body_length`, `nesting`: extract helpers without changing
     order or error handling.
   - `large_tuple`: replace tuple returns and stored tuples with small named structs.
   - `empty_count`, `non_optional_string_data_conversion`, `optional_data_string_conversion`,
     `type_name`, `static_over_final_class`: apply the direct fix.
2. After each rule family, regenerate the baseline with
   `swiftlint lint --strict --write-baseline .swiftlint-baseline.json` and commit the lower count.
3. Keep `.swiftlint-baseline.json` checked in until it reports zero, then delete it and remove
   `--baseline` from CI and local commands.
4. Run the full suite after each family that touches behavior-adjacent code.

### Task 30: Final line-length and wrapping pass

Files:
- Modify Swift files reported with `line_length`
- Append the commit to `.git-blame-ignore-revs`

1. Run:
   ```bash
   swiftformat cmd/ios-app --config .swiftformat \
     --rules wrap,wrapArguments,wrapAttributes,wrapMultilineStatementBraces \
     --max-width 120 --wrap-arguments before-first --wrap-collections before-first \
     --wrap-conditions before-first --wrap-parameters before-first
   ```
2. Fix residual long string/comment lines by hand. Do not change string content; split with
   concatenation or a multiline string only when the rendered text stays byte-identical.
3. Run `swiftlint lint --strict`; `line_length` must be zero.
4. Run the full suite and commit the formatting change.
5. Append the formatting commit hash with `git rev-parse HEAD >> .git-blame-ignore-revs`, then commit
   the ignore-revs update separately.

### Task 31: Remove the baseline, close the audit, and verify the campaign

Files:
- Delete `.swiftlint-baseline.json`
- Modify `.github/workflows/ios.yml`
- Modify `.swiftlint.yml` if comments still mention the baseline
- Modify `CODE_AUDIT.md` §9, §14.4, summary table
- Modify `cmd/ios-app/ARCHITECTURE.md` with final budgets and commands

1. Run `swiftlint lint --strict` from the repository root and require zero violations.
2. Remove `--baseline` from CI and the documented commands. Confirm the SwiftLint and SwiftFormat
   steps are blocking.
3. Confirm all budgets are at or below the Task 5 targets and no file has a whole-file suppression.
4. Run:
   ```bash
   cd cmd/ios-app
   ./run-tests.sh
   cd ../..
   swiftformat --lint cmd/ios-app --config .swiftformat
   swiftlint lint --strict
   ```
5. Build the app and widget with zero warnings. Smoke test launch, sign-in, all tabs, Battery Saver
   sheet/control, widget, and Live Activity.
6. Update `CODE_AUDIT.md` §14.4 to FIXED with the final counts and update every §9 entry touched in
   this campaign. Update the summary table counts.
7. Commit the final gate. Open a draft PR with the full task list and test evidence.

**Campaign exit criteria:**
- `swiftlint lint --strict` reports zero violations with no baseline.
- `swiftformat --lint cmd/ios-app` is clean.
- Full test suite passes, with the same test semantics as the 667-test baseline.
- `xcodebuild ... build` has zero Swift compiler warnings.
- Every production file is under 400 lines where practical; any remaining file between 400 and 500
  has a recorded reason in `ARCHITECTURE.md`, and none exceeds 500.
- `CODE_AUDIT.md` §9 and §14.4 accurately describe what was fixed.
- No product copy, API contract, persistence format, refresh cadence, or user-visible behavior
  changed.
