# SolarHealth

Solar health scoring: the baseline and its score, the classifier and its aging rules, the health pass
and its cache, yearly fits against a weather reference, and the owner's manual layout model.

**App side**

- `PWUsage/State/Solar/SolarHealthModel.swift` and `SolarHealthPass+Run.swift`: running a pass.
- `PWUsage/State/Solar/ManualSolarLayout+Editing.swift`: editing the manual layout.
- `PWUsage/Views/SolarSystem/`: the Solar System screens.

**Tests:** `Tests/PWUsageCoreTests/SolarHealth/`, plus the opt-in 10-year degradation backtests in
`DegradationBacktest/` (`run-core-tests.sh --full`).
