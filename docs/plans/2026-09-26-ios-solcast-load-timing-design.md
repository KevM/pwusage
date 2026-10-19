# iOS Solcast load timing design

## Agreed direction

Recommend the lowest estimated cost start time for a selected load, showing expected solar contribution alongside the recommendation. This is an iOS feature. Each user enters their own Solcast key on their device; the phone fetches and caches forecasts and performs the comparison. PWUsage servers never receive the key, Solcast resource IDs, or forecast data. No appliance or Powerwall commands are issued.

This document records the agreed direction and proposed implementation defaults. The defaults below are engineering assumptions, not claims that Solcast or battery forecasts are certain.

## Progressive enhancement (required)

The existing nonforecast load estimator is the default experience for every user. Solcast is optional: a locally stored key enables attempts to enhance the estimate, with no additional feature toggle or mandatory setup gate. Array selection must still be completed before forecasting can be used. Users without a key retain the existing profiles, tariff/balance calculation, and load estimate unchanged; do not issue Solcast or forecast-only planning-context requests for them.

Render the existing estimate immediately while optional forecast inputs load. Upgrade it only when the key, array association, complete fresh forecast, and planning context are usable. On a Solcast request failure that leaves no usable forecast, automatically show the existing nonforecast estimate. *(Revised 2026-10-18, decided by the owner: a current forecast is not dismissed.)* A refused or failed request (quota exhaustion, a rate limit, timeout or network error, a server error, or an unreadable response) keeps the last saved forecast usable until it is six hours old. Only problems with the key or the selected arrays (invalid credentials, an unknown array) disable it, as does a failure record that can't be saved. Missing/stale inputs, incomplete setup, and planning-context failures follow the same path. A forecast failure must never hide or block a valid basic estimate, reset the selected profile, or require a retry to use Load timing. The basic estimator's own missing-tariff/data states still apply.

Keep connection setup optional and nonblocking. Label the enhanced result as using a solar forecast. When a configured connection fails, use a small informational note such as “Solar forecast unavailable — using tariff and balance data”; no blocking error screen or repeated connection prompt. A successful subsequent refresh automatically restores the enhanced estimate. Removing the key immediately restores the basic experience. Test transitions in both directions, not just isolated empty/error screens.

## Prerequisite

Complete `2026-09-25-ios-configurable-load-profiles-implementation.md` first, or verify its equivalent has landed. At planning time, profiles with duration and the upcoming tariff timeline exist only in that plan. Reuse its load energy, duration, tariff segments, and fallback estimate; do not create a second profile system.

## Connection and privacy

Add Solar forecast settings within Load timing. Enter a key, discover rooftop systems, and explicitly select one or two arrays for the current PWUsage site. Tags can suggest a selection but never silently bind sites. Store the selected resource IDs, not a mutable tag, as the association. The user's East and West arrays were confirmed through one read-only discovery request; both carry the Harrison tag. No real identifiers, locations, keys, or captured account responses belong in fixtures.

Use a separate cookie-free, ephemeral URLSession for Solcast. Authenticate only to the fixed HTTPS Solcast host with a Bearer header, and reject redirects. Store the key in a non-synchronizing, device-only Keychain item. Exclude forecast files, selection metadata, and quota bookkeeping from backup; never include them in analytics or diagnostic payloads. Scope associations/cache to the app account and PWUsage site. Disconnect deletes credentials and associated cache; sign-out clears credentials and forecast associations/cache. Preserve a nonsecret per-credential request-budget fingerprint across disconnect/reconnect so reconnecting cannot reset today's request counter.

The existing development `.env` key is not an application credential source. Leave that file untouched. Do not embed the key in the app or use a backend proxy.

Device-local use avoids our service collecting customers' keys or forecasts. Published hobbyist terms still do not explicitly approve this particular integration. Record that uncertainty; do not claim vendor approval. Public release review should resolve applicability with Solcast; private implementation and fixture-based testing can proceed.

## Forecast refresh and normalization

Use rooftop discovery during setup, then fetch each selected array's forecast separately. Align intervals by UTC start/end and sum power. Parse `period_end` and ISO duration; do not interpret an end timestamp as a start or sum arrays by array index. A 30-minute interval at 4 kW contains 2 kWh. Require all selected arrays for a usable combined interval. Missing data is unknown, including at night unless the API explicitly represents zero production; never treat a missing array as zero.

Refresh on foreground entry to Load timing if the cache is older than three hours, with a default automatic allowance of eight request attempts per UTC day and a hard local cap of ten. Count all Solcast attempts conservatively, including discovery and failures; reserve enough budget for the complete array set before starting a refresh. Manual refresh may use the remaining allowance. Persist the count before dispatch; deduplicate concurrent requests. Honor 429 and Retry-After without retry loops. Other apps/devices may consume the same account quota, so the local count is not authoritative remaining quota. No scheduled background guarantee and no estimated-actuals fetches.

Keep the last complete batch in storage if one array fails, but switch the active estimate to the basic fallback after that failed refresh; retained data must not mask the failure. A valid cached batch can enhance the estimate when no refresh failure is outstanding. Mark forecast age prominently: up to six hours old can inform a recommendation; older data can be displayed as stale but cannot produce a new recommendation. These age/budget defaults are centralized and tested. Expired or incomplete forecasts fall back to the existing nonforecast estimate. Clear the failed-refresh state only after a successful complete refresh (or disconnect, which leaves the basic estimator active).

## Expected household and battery behavior

Solar alone cannot predict available surplus. Add an authenticated, bounded mobile planning-context endpoint containing historical local-time profiles derived only from stored Tesla observations. It must not fetch Tesla data. It returns typical home consumption plus typical net battery charging (charge positive, discharge negative), sample counts, units, timezone, source coverage, and an as-of timestamp. The phone combines these inputs with Solcast locally.

Proposed baseline: median power for each local half-hour across the previous 14 complete local days, requiring at least five valid day samples per slot. Require at least 90% observed interval coverage before a day/slot contributes. First integrate raw observations using the repository's verified units and sampling semantics; never average missing observations as zero. Collapse a repeated DST slot within each day before giving that day one vote; missing spring-forward slots contribute no sample. Do not silently clip genuine negative battery power.

This is a historical battery-behavior approximation, not a dispatch or SOC simulation. It assumes battery behavior is unchanged by the extra load. Show that limitation in the estimate details, particularly for large car charges. Do not promise Powerwall refill or remaining charge. Do not alter battery provenance accounting or introduce SOC-based cost-basis seeding. Household history can include previous discretionary loads; the median limits isolated events but does not identify appliances.

## Cost comparison

Search starts from now through the end of tomorrow in the site's timezone. Include now, half-hour forecast boundaries, tariff transitions, and tariff transitions minus the run duration where valid. Consider only complete runs within the shared usable horizon. Keep the first version inside the current billing cycle and a single supported rate set per tariff-period balance; truncate at a cycle boundary or incompatible tariff/rate change. The UI states the actual search horizon.

The common horizon H is the earliest of end-of-tomorrow, the end of complete forecast/context/tariff coverage, and the billing-cycle boundary. Every candidate uses the same H, including start-now. Start from observed signed cycle net-export balances B0 at their source time. Require that source time to be no more than 30 minutes old (an hour when the planning context carries grid history, which fills the gap before the forecast's first interval); project the small gap to now with the same baseline when coverage exists, or fall back. Never add forecast for time already included in B0.

For every interval from the balance source time to H, derive baseline net export:

`netExportKwh = solarKwh - homeKwh - batteryNetChargeKwh`

Accumulate it into its tariff-period balance to obtain Bbase. Negative balances must remain negative. For a candidate run, split its evenly distributed wall energy at all relevant boundaries and subtract each segment's energy from the corresponding balance, yielding BwithLoad. Price each period using:

`C(B) = max(-B, 0) * buyRate - max(B, 0) * sellRate`

`incrementalCost = sum(C(BwithLoad) - C(Bbase))`

This matches the existing per-period netting assumption over an explicitly bounded forecast horizon. It is not a prediction of the final monthly bill, because later days may change the surplus. Repeated segments share one signed balance. Do not separately charge forecast solar, spend banked surplus twice, or clamp away an existing deficit. Rates of zero and negative prices are legitimate finite inputs.

Select the minimum estimated incremental cost, preferring the earlier start on ties. Recommend waiting only if estimated savings exceed one minor currency unit; otherwise show that starting now is similarly priced. Use the currency's actual minor unit (do not assume all currencies have two decimal places). Show now cost, recommended cost, savings, start/finish, source ages, and search horizon.

Separately report approximate solar contribution during the load as the integral of `min(loadPower, max(solarPower - homePower - max(batteryNetChargePower, 0), 0))`. This does not label battery discharge as solar and does not imply that stored billing surplus is physical solar supply. Clamp contribution to the load's energy. Label it an estimate under typical household/battery behavior.

## Scope and verification

No web/TRMNL UI, backend Solcast calls, new database tables, automation, forecast calibration, battery optimizer, or cloud credential storage. The only backend addition supplies bounded existing usage context to the native client.

Use synthetic provider fixtures for normal, malformed, missing-array, quota, stale, and DST cases. Test the cost function with hand-calculated amounts, including a case where sunny hours are not cheapest under tariff netting. Verify all candidate comparisons share H. Verify outgoing Solcast traffic cannot carry app cookies and outgoing PWUsage traffic cannot contain Solcast credentials or data. See the implementation plan for the task sequence and release checks.

## References checked 2026-09-26

- https://docs.solcast.com.au/docs/section/rooftop-sites-hobbyist — two arrays, 30-minute periods, ten requests per UTC day, rooftop resource endpoints.
- https://docs.solcast.com.au/docs/authentication — Bearer authentication.
- https://www.solcast.com/terms-of-use — personal-use and sharing restrictions; device-local integration permission remains unconfirmed.
- https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly — device-only Keychain accessibility.
- `DesignDecisions.md`, section 4 — preserve relative-flow battery provenance.
