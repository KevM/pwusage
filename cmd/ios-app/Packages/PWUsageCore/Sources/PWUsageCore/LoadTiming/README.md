# LoadTiming

Smart Shift's engine: saved Jobs and their store, car charge steps, the forecast estimator and its
projections, and `SmartShiftEvaluator`, which picks the projection (solar forecast, then grid history,
then flat). `SmartShiftDiagnostics` records a pass as JSON and replays it offline.

**App side**

- `PWUsage/Views/LoadTiming/`: `SmartShiftPresentation` (card copy and display decisions; its
  `evaluate` wraps `SmartShiftEvaluator` and supplies the forecast note) and the views.
- `PWUsage/State/Home/DashboardCoordinator+LoadTiming.swift`: when a pass runs.

**Tests:** `Tests/PWUsageCoreTests/LoadTiming/`. Shared fixtures: `Support/SmartShiftFixtures.swift`
and `Support/SmartShiftScenario.swift`.
