# BillPricing

Everything that prices a bill or edits a rate plan without touching the UI:

- **Pricing**: billing cycles, the rate period resolver, local bill assembly from energy flows, Bill
  Outlook projections and shifts, marginal cost and the next cheaper period.
- **Rate plans**: the timeline cache, tariff timeline validation, drafts and their write requests,
  the rate plan history guide's walk-back, fixed comparison pairing and staging, Rate Plans polling
  and scroll targets.
- **Contracts**: tariff writes, public utility plans, Tesla Sync, rate plan reviews and selection
  (including 409 conflicts), AI handoff.

**App side**

- `PWUsage/Models/Bill/`: presentation, copy, formatting and the observable editor and review models.
- `PWUsage/State/Bill/`: `LocalBillBuilder` (reads the history store) and the bill shadow comparison.
- `PWUsage/Networking/PWUsageAPI+Tariffs.swift` and `+RatePlanSelection.swift`: transport.
- `PWUsage/Views/Bill/`: the screens.

**Tests:** `Tests/PWUsageCoreTests/BillPricing/`, including server pricing parity against
`Fixtures/BillPricing/`. Shared fixtures: `Support/TariffTimelineFixture.swift` and
`Support/RatePlanResponseFixture.swift`.
