# BatteryHold

Battery Saver's wire models and their rules: the hold and its monitoring, the response, commands and
their results, the owner's choice, and the reserve plan for a given charge. Validation fails closed:
a response for another site, an out-of-range reserve or an empty body throws `PWUsageAPIError`.

**App side**

- `PWUsage/Models/BatteryHold/`: `BatteryHoldState`, `BatteryHoldFailure` (copy) and the Live
  Activity content mapping.
- `PWUsage/State/BatteryHold/` and `PWUsage/Views/BatteryHold/`: the Live Activity coordinator, the
  sheet and its presentation.
- `Shared/BatteryHold/`: the Live Activity attributes the widget renders.

**Tests:** `Tests/PWUsageCoreTests/BatteryHold/`. Copy and state tests stay in `PWUsageTests`.
