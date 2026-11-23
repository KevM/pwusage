# Savings

The Savings and Payback calculations: the savings report against a fixed comparison plan, scenario
flows, rate growth, and the payback projection for system costs.

**App side**

- `PWUsage/State/Savings/SavingsModel.swift`: loads history, caches and refreshes.
- `PWUsage/Models/Savings/SavingsHistoryCoverage.swift`: ties older-history state to labels and copy.
- `PWUsage/Views/Shared/SavingsPresentation.swift`, `PaybackPresentation.swift` and the Bill and
  Solar System views.

**Tests:** `Tests/PWUsageCoreTests/Savings/`.
