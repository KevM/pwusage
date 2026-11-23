# SiteCountry

Finds a site's country on the device from its saved, rounded home location, so the coordinates never
leave the phone. `CountryBoundaries` reads the bundled outlines and does the point-in-country and
border-distance math. `SiteCountryResolver` turns that into an inference, decides what to report to
the server, and when to ask the owner.

**App side**

- `PWUsage/Resources/country-boundaries.bin`: the outlines, built by `make-country-boundaries.py`.
  The file stays in the app bundle and is read from `Bundle.main`.
- `PWUsage/State/Home/DashboardCoordinator+RateCountry.swift` and
  `PWUsage/Models/Bill/SiteCountryPickerModel.swift`.

**Tests:** `Tests/PWUsageCoreTests/SiteCountry/`. They read the repo's `.bin` through
`Support/CountryBoundariesFixture.swift`.
