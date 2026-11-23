# SolarForecast

The solar forecast: Open-Meteo client and provider, the forecast service, the request ledger and
automatic cache, history and correction, and site-local day math (`SiteLocalDays`).

**App side**

- `PWUsage/State/Home/DashboardCoordinator+Solar.swift` and `+AutomaticForecast.swift`, and
  `PWUsage/State/Solar/BackgroundSolarForecastRefresh.swift`: when forecasts refresh.
- `PWUsage/Views/Solar/`: settings and display.

**Tests:** `Tests/PWUsageCoreTests/SolarForecast/`. Shared support:
`Support/SolarForecastTestSupport.swift`.
