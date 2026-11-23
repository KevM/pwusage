# PWUsageCore Bill and Rate Plans Extraction Implementation Plan

**Goal.** Run the portable Billing and Rate Plans calculations, validation, and persistence tests on macOS through `./cmd/ios-app/run-core-tests.sh`.

**Base.** Start from `origin/main` at `8d9a934b` after #427 in `.worktrees/ios-core-bill`. Savings extraction is underway in #428. Refresh the caller inventory after it merges, especially the Savings timeline fingerprint and the simulator bill fixture consumers.

**Boundary.** Move portable code into `cmd/ios-app/Packages/PWUsageCore/Sources/PWUsageCore/BillPricing/` and its matching test directory. Extend the existing shared tariff DTO files when declarations belong with those contracts. Keep API, coordinator, navigation, copy, and UI behavior in the app. Maintain encoded payloads, persisted cache formats, historical tariff lookups, and #427’s pairing and review behavior.

## Task 1 — Move the timeline cache

- [x] Move `PWUsage/State/Bill/RatePlanTimelineStore.swift` and `SavedRatePlanTimeline` to the existing `BillPricing` domain. Expose the actor methods and cached-entry fields used by the app. Preserve the SHA-256 file key, Codable fields, actor isolation, and atomic writes. Guard file-protection attributes and write options on iOS.
- [x] Move the file round-trip from `PWUsageTests/RatePlanTimelineStoreTests.swift` to the core tests with a package-owned timeline. Keep the 304, editor mutation, and sign-out tests in the iOS target. Run the full suite before committing.
- [x] Document that the core package owns portable timeline persistence. App orchestration still handles API revalidation and session cleanup.

Verified the cache extraction with 371 native tests, 1,582 simulator tests, strict lint, and the runner self-tests.

## Task 2 — Move wire values and pure Rate Plans rules

- [ ] Audit `Models/Bill/{MobileTariffs,RatePlanSelection,RatePlanReviewDTO,RatePlanHistoryDTO,FixedComparisonChoice,SiteRateCountry,SystemCosts,TeslaSyncDTO}.swift`. Move encodable/decodable value declarations together with their dependencies. Split out app API extensions, `PWUsageAPIError` mapping, and user-facing error copy. Preserve all custom encoding, optional-field defaults, and coding keys. Move the pure assertions in `MobileTariffsDecodingTests*.swift` and retain app API tests.
- [ ] Audit `RatePlanDraft.swift`, `SeasonDraft.swift`, and `RateFormatting.swift`. Move date, month, coverage, window, and numeric validation together with the test assertions in `RatePlanDraftTests.swift`. Map typed failures to existing messages in the app wherever validation currently returns user-facing text. Reuse the date helper introduced by #428 once available and preserve UTC and site-local behavior.
- [ ] Move the pure span and period compilation in `RatePlanHistoryFlow.swift` and `RatePlanHistoryFlow+Review.swift` with `RatePlanHistoryFlowTests.swift` and pure pairing cases from `RatePlanHistoryFixedComparisonTests.swift`. Leave display-option construction with the app when it depends on `FixedComparisonPresentation`. Preserve #427’s staged choices, current-year fallback, encoded effective dates, and pairing gaps.
- [ ] Review small pure decisions in `RatePlansPolling.swift` and mixed files such as `RateEstimatesAccessoryModel.swift`. Keep app-specific editor routes, scroll destinations, setup prompts, observation-backed picker and review models, and their app tests. Review each remaining test’s dependencies even if its filename names a model.

### App ownership

- Keep `PickerChoice`, `RatePlanEditorState`, `RatePlanAddFormRule`, and `RatePlansScrollTarget` with the editor and navigation.
- Keep `FixedComparisonPresentation`, `RateEstimatesPresentation`, `RatePlanHistoryPresentation`, `RatePlanReviewPresentation`, `RatePlanTimelineFormatting` display methods, `TeslaDivergenceCopy`, and `TeslaSyncCopy` with their display tests. Move only dependency-free calendar and value handling where a core caller needs it.
- Keep `FixedComparisonChangeModel`, `RatePlanAiHandoffModel`, `RatePlanChangeModel`, `RatePlanHistoryModel`, `RatePlanReviewModel`, `SiteCountryPickerModel`, `TeslaSyncModel`, `UtilityPickerModel`, and `UtilityPlanPickerModel` with their observable or API-driven tests. Audit pure subtypes, such as request values, separately from those models.
- Keep `BillPricingMode` with app configuration and `DashboardCoordinatorBillShadowTests+Support.swift` with its integration suite.

## Task 3 — Move Bill assembly and comparison

- [ ] Split the pure `MobileBillResponse` contract from `PWUsage/Models/MobileContracts.swift` if needed by the package. Keep the existing wire validation for versions, site IDs, finite amounts, and optional outlook. Move the pure contract checks from `MobileContractsBillTests.swift`, using the same date decoding semantics.
- [ ] Split `State/Bill/LocalBillBuilder.swift` at the history-store boundary. Leave the async read and app readiness adapter with the app. Move the assembly that takes flow days and the resolved timeline, including period summaries, last observed slot, outlook, and LoadTiming composition. Consider moving `timelineFingerprint` alongside assembly while keeping the exact hash payload and the Savings caller working. Verify nested contract access with the simulator compiler.
- [ ] Audit `Models/Bill/{BillOutlook,BillOutlookShift,BillOutlookProjectionCache}.swift` for package-only dependencies and presentation-specific behavior. Move the portable projection and comparison algorithms with existing pure tests. Let the app retain view caching and any presentation/copy adapters required by current callers.
- [ ] Move the pure difference and daily-total logic in `State/Bill/BillShadowComparison.swift` with the matching tests. Keep coordinator-specific reporting state and `DashboardCoordinatorBillShadowTests.swift` in the simulator suite.
- [ ] Run `rg -n 'BillPricingFixture\.load|single-plan-cycle\.json' cmd/ios-app` after migrations. Remove the app fixture loader and `project.yml` resource entry only if no simulator test needs them. #428 retains the real-store Savings/Bill comparison in `LocalBillBuilderTests.swift`.

## Task 4 — Verify the extraction

Keep public access limited to real app and simulator-test callers. Use Swift Testing and strict SwiftLint with no suppressions. Keep `DEVELOPMENT_TEAM: 6HQGHHRK87`. Update the iOS guides to reflect the final package contents.

- [ ] `./cmd/ios-app/run-core-tests.sh`
- [ ] `./cmd/ios-app/lint.sh`
- [ ] `./cmd/ios-app/test-run-tests.sh`
- [ ] `./cmd/ios-app/run-tests.sh`
