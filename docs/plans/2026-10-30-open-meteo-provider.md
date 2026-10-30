# Open-Meteo automatic forecast implementation plan

Goal: Continue PR #258 by making Open-Meteo the automatic beta forecast with on-device array modelling and opportunistic background refresh.

Architecture: Reuse SolarForecastProviding, SolarForecastService, automatic cache, configuration-partitioned raw history, and correction from #258. Solcast remains the explicit credential provider. Fetch hourly GHI/DNI/DHI in UTC in one weather request, then model all detected planes locally. Preserve the 0.5–1.5 correction clamp initially. Background work invokes the same service without requiring dashboard presentation. Forecasts older than the existing usability limit remain unavailable to recommendations.

1. Establish baseline with run-tests.sh. Generate synthetic pvlib reference cases without household data. Write Swift Testing cases for solar geometry/model, end-labelled radiation alignment, clipping, malformed/missing weather, and DST coverage; verify failure before implementation.
2. Implement a hardened OpenMeteoClient (HTTPS host validation, no redirects/cookies/cache, bounded timeout, constrained-network opt-out, finite/nonnegative complete radiation). Request UTC Unix timestamps and hourly radiation, preserving full today/tomorrow coverage.
3. Implement local solar position, Hay-Davies plane irradiance and physical IAM; 14% losses and AC clip match the backtest. Version the provider fingerprint. Compare model output against independent synthetic pvlib fixtures, including low sun, seasons and hemispheres.
4. Register OpenMeteoProvider as the automatic provider. Reuse caching and raw history while fencing account/configuration changes, coalescing fetches and respecting Retry-After. Keep Forecast.Solar code available but unselected. Update settings/attribution/privacy and integration tests. Keep beta/release gates.
5. Register short BGAppRefreshTask handling with the SwiftUI scene and schedule at background transitions, with a headless refresh path for the signed-in authorized site, no location requests, no Tesla live calls, and no unrelated dashboard loading. Revalidate auth/layout; respect Low Data Mode and Low Power Mode. Reschedule each execution; cancel on expiration; complete once. Persist only required forecast state using protection compatible with execution after first unlock; never weaken credential storage. Preserve account/site fences.
6. Run focused tests then full run-tests.sh, SwiftLint, and required web checks. Inspect failures and artifacts before retrying. Update task.md and PR description around final behavior, commit only task changes, and push to PR #258 after checking its head for concurrent updates.

Evidence limits: Harrison backtest establishes skill over history for fixed ~24h leads, not matched previous-evening issuance or superiority over Forecast.Solar across sites. Synthetic numerical fixtures are committed; household captures remain excluded. Prospective evaluation is still required before widening release.


## Implemented behavior and validation

The SwiftUI scene registers `.backgroundTask(.appRefresh(...))`. Scheduling occurs on background transitions and inside the task handler, after registration; submitting from App.init was caught by simulator launch testing and removed. Refresh targets the saved selected site and revalidates authorization, layout, timezone and actuals without loading dashboard/bill state or requesting location. Low Data Mode opts out through URLSession; Low Power Mode skips work.

Protected automatic cache/history now live in a separate background-accessible directory. Existing automatic cache/correction history cold-start once; the legacy copies are removed after a successful new save, including sign-out's empty save. Credential storage is unchanged. A cold locked launch conservatively skips when Solcast credential metadata cannot be loaded; a resident unlocked-initialized store can refresh while locked. Sign-out fences protect suspended initial cache/history loads from repersisting old-account data.

Verification: full iOS suite passes (803 executed, five intentionally skipped; Swift Testing reports 808 total), 23 focused tests pass, strict SwiftLint with baseline/no cache passes, 1,748 web tests pass (161 skipped), web lint and production build pass. The iOS Release simulator build also passes. Independent review found and verified fixes for sign-out storage races and coalesced-request cancellation. Real-device background scheduling remains an owner smoke check because system timing is opportunistic.
