# SharedModels

Wire contracts and value types more than one domain or target uses:

- The live dashboard contract (`MobileLiveContract.swift`). It is the client half of
  `cmd/next-app/src/lib/mobile-dashboard-contract.ts`: change both in the same PR.
- Site, bill and planning context contracts, and `MobileContractDecoder` (build one per response).
- `PWUsageAPIError`, which contract validation throws.
- Tariff timeline and metadata DTOs, energy flow days, Bill Outlook, load timing timeline models, and
  `SiteTimeZone` (DST-aware time zone math shared across Apple and Wasm builds).
- Today's Energy snapshot and cost (the widget's data), and the TRMNL device and screen contract.

**App side**

- `PWUsage/Networking/`: transport and the API protocols.
- `Shared/`: the widget's snapshot store (app group, file protection), layout and presentation.

**Tests:** `Tests/PWUsageCoreTests/SharedModels/`.
