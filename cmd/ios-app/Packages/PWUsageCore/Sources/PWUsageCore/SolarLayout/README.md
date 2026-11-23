# SolarLayout

Solar layout detection: sun position, clear-day selection, plane fitting and shading, readiness,
the site's layout record and its merge with another device's record, and the history onboarding
checkpoint rules (`SiteHistoryCheckpoints`).

**App side**

- `PWUsage/State/Solar/`: the record store, detection runner, CloudKit sync and serializer, history
  store, and `SiteHistoryOnboarding` (which reads stored progress and forwards to
  `SiteHistoryCheckpoints`).
- `PWUsage/State/Home/DashboardCoordinator+SolarLayout.swift` and `PWUsage/Views/Solar/`.

**Tests:** `Tests/PWUsageCoreTests/SolarLayout/`, with fixtures in `Fixtures/SolarLayout/` (year
fixtures are opt-in with `run-core-tests.sh --full`). Shared fixture:
`Support/ManualSolarLayoutFixtures.swift`.
