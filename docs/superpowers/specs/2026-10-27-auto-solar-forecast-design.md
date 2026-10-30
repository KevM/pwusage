# Auto-configured solar forecast (Forecast.Solar default, Solcast alternative)

Date: 2026-10-27. Original design; implementation started in PR #258.

2026-10-30 update: the owner selected Open-Meteo as the preferred automatic provider,
with on-device array modelling and opportunistic background refresh. Beta sites use
this path exclusively, even when Solcast credentials are saved; failures use history. The original
Forecast.Solar sections below record the earlier design. See the
[Open-Meteo continuation plan](../../plans/2026-10-30-open-meteo-provider.md).

## Intent

Smart Shift and the bill projection are better with a solar forecast, but today
only users who create a Solcast account, describe their roof there, and paste a
key into the app get one. Most users never will. The goal is a forecast that
needs **no setup**: PWUsage works out each site's panel layout from its own
production history and fetches a free forecast for that layout. Solcast stays
as the opt-in alternative because it is more precise and covers 7 days.

Asking users to type in their roof details was rejected: it is no easier than
signing up for Solcast, and survey answers proved unreliable (see Evidence).

## Goals

- A site with enough history gets a solar forecast with zero user input beyond
  one location permission.
- The layout is detected from production history on the server and refreshed as
  history grows; the forecast is fetched on the phone from Forecast.Solar's free
  public API.
- Solcast, when connected, always wins for that site.
- The forecast plugs into the existing consumers (`SolarForecastInterval`)
  without changing Smart Shift's logic.

## Non-goals (v1)

- A form for users to enter or edit their layout. The detected layout is shown
  read-only so users can see what the app thinks.
- A user's own paid Forecast.Solar key (longer horizon, 15-minute steps). Later.
- Forecasts on the web dashboard or TRMNL. Phone only, like Solcast today.
- Replacing Solcast's `pv_estimate10` cautious run. Forecast.Solar has no
  percentiles; the cautious run falls back to the median as it already does.

## Anti-goals

- A confident-looking forecast built on a bad layout. A low-confidence
  detection must not produce a forecast; the app keeps today's history-based
  behaviour and says why.
- Sending any user data to Forecast.Solar beyond a rounded location and the
  plane geometry it needs.
- Calling Forecast.Solar from the server. Its free limit is 12 calls/hour **per
  IP**; Vercel's shared egress would exhaust it for everyone. Its terms also ask
  apps to call the public API from the user's device.

## Evidence (research done 2026-10-23 to 2026-10-27)

All throwaway code is in `.forecast-compare/` in the main checkout (git-excluded,
not in the repo). Summary in `.forecast-compare/RESULTS.md`.

- **Forecast.Solar public tier:** no key, 12 calls per rolling hour per IP,
  one plane per call, today + tomorrow, hourly values (`watt_hours_period`,
  local-time keys, irregular sunrise/sunset points). Azimuth convention 0 = S,
  -90 = E, 90 = W, ±180 = N; tilt 0-90 integer; size in kWp.
- **Blind detector** (`.forecast-compare/detector/detector.py`, Python + pvlib,
  built by an agent that never saw the true layouts): clear-sky selection by
  envelope ratio, learned shading mask by sun position, exhaustive azimuth ×
  tilt grid for 1-3 planes with linear size solve, day-blocked cross-validation
  for plane count, AC clip detection, bootstrap confidence ranges.
- **Backtest** (`.forecast-compare/backtest.py`): each layout modelled from
  Open-Meteo historical hourly irradiance and scored hourly against actual
  production, with one scale factor fitted on alternate weeks (isolates shape
  from size). Calibrated hourly error, lower is better:

| Site | History | Reported layout | Detected | Generic south 20° |
|---|---|---|---|---|
| Harrison WI (east/west) | 1 yr | 22.1% | 21.5% | 26.5% |
| San Diego | 10 mo | 17.9% | 17.6% | 21.6% |
| Vermont (heavy shade) | 4 mo | 41.4% | 40.6% (flagged low confidence) | 38.1% |
| Rancho Palos Verdes | 8 wk | 23.0% | 16.0% | 16.3% |
| Granada Hills | 1 yr | 22.6% | 14.9% | 25.9% |

  - With 8+ weeks and moderate shade, detection matches or beats what owners
    reported. A full year separates east/west from flat; 7 weeks did not.
  - At Granada Hills it recovered the 5/12 pitch (23°) and the 7.6 kW inverter
    (clip at 7.68 kW).
  - It fails under heavy shade with short history, and says so.
  - Detected DC sizes run 6-19% high (0.85 loss assumption).
- **Forecast.Solar vs Solcast accuracy is not settled.** A daily forward
  capture (`.forecast-compare/capture.py`, `score.py`) has only 3 days: Solcast
  led, Forecast.Solar ran 45-50% low on cloudy days for every layout, which
  points at its weather input, not the layout. Keep collecting for 3-4 weeks
  before launch (see Open risks).

## Design

### 1. Location (phone → server, once)

- In the Solar forecast settings (and a one-time prompt in Smart Shift), the
  phone asks for When-In-Use location, reads one fix, rounds to 2 decimals
  (~1 km) and posts it to the server for the site. The user is asked to do this
  at home; copy says so.
- Stored per site. If the user declines, no automatic forecast (history
  fallback as today). Re-asking is a settings button, never a nag.
- Multi-site accounts: the phone offers the fix only for the currently selected
  site and asks "Are you at <site name> now?" first. The server sanity-checks
  the stored longitude against the site's solar-noon timing from its history
  and, if they disagree by more than 1.5°, keeps the location but marks any
  detection `low` with reason `location-mismatch`.
- Location from production timing alone was tested and is only good to ~70 km
  in longitude; not used.

### 2. Layout detection (server)

- **Runtime: TypeScript in the Next.js app** (my call). One runtime, Vitest
  coverage, no pvlib/h5py packaging. The Python detector is the reference:
  port its method, then check parity on the five sites. **Parity bar:** same
  confidence level and plane count for `high`/`medium` sites, and backtest
  calibrated hourly error within 1 percentage point of the Python result per
  site. Matching azimuth within 5°, tilt within 3° and size within 3% is the
  expectation for `high` sites but not a hard bar, since the optimiser and
  bootstrap are seed-dependent; an equally good but different fit passes.
  **Test data:** the five research sites are other households' data and are
  never committed. Parity against them is a local-only script. CI gets
  synthetic fixtures generated from known layouts (clear-sky model + cloud
  noise + a shade mask + clipping), including an east/west pair, a single
  south face and a short-history case, with the detector expected to recover
  each within the ranges above. Needed pieces: solar position
  (NREL SPA or an accurate simpler algorithm), extraterrestrial irradiance, a
  clear-sky model (Ineichen needs a Linke turbidity table; a simpler model such
  as Simplified Solis with climatological inputs is acceptable since the
  envelope selection is ratio-based and size is corrected later), Hay-Davies
  transposition, physical IAM.
- **Input:** the site's 5-minute `solar_power` from its day records
  (`createEnergyRepo` / `EnergyDayArchive`), up to the last 365 days, plus the
  stored location and timezone. Samples are Wh per 5 minutes labelled at
  interval start (evaluate the sun at interval midpoint).
- **Output** stored per site: planes (compass azimuth, tilt, DC kWp), AC clip
  kW or null, confidence (`high` / `medium` / `low`), history window and days
  used, detector version, detected_at. Keep the previous result when a run
  fails.
- **Confidence rule** (builder may refine with the parity data): `low` when
  fewer than 15 clear days were found, or a chosen plane sits at the tilt
  limit, or the bootstrap azimuth range of the largest plane is wider than 60°.
- **Minimum history:** 6 weeks of day records with data (my call). Below that,
  no detection.
- **Schedule:** a pg_cron job calling a new `/api/cron/*` route, following the
  existing pattern (Bearer `CRON_SECRET`, `maxDuration` 60, `withIoDeadline`,
  staggered minute slot). It processes a few sites per run: sites with a
  location and no result, then results older than 30 days. Measure Supabase
  egress per run on the Dev DB before enabling (a year of day records is about
  1.3 MB per site).
- **Detection must fit in the 60 s Hobby limit per site.** If the full grid is
  too slow, coarsen the grid and refine continuously, or split a site across
  runs. Measure on Harrison's year.

### 3. Delivery to the phone

- Extend the mobile contract with the site's solar layout (or add
  `/api/mobile/solar-layout`; builder's choice): `{ planes, acClipKw,
  confidence, detectedAt, location: {lat, lon} }` or `null` with a reason
  (`needs-location`, `not-enough-history`, `low-confidence`, `pending`).
- Authorization as for other mobile endpoints (`verifySiteAccess`).

### 4. Forecast fetch (phone)

- New `ForecastSolarClient` beside `SolcastClient`, same hardening (ephemeral
  session, no cookies, redirects rejected, host check, bounded timeout).
- One request per plane: `GET https://api.forecast.solar/estimate/{lat}/{lon}/{dec}/{az}/{kwp}`
  with compass azimuth converted (`az_fs = compass - 180`, normalised to
  -180…180), tilt rounded to an integer, kWp from the detected DC size.
  At most 3 planes, so at most 3 calls per refresh.
- Convert `result.watt_hours_period` to `SolarForecastInterval`s: keys are local
  time in `message.info.timezone`; each value covers (previous key, key]. Fill
  night and any gap up to the full local day with zero-kW intervals so the
  result is contiguous for today and tomorrow (the consumers require a
  contiguous block covering now). Sum planes by interval, as
  `SolarForecast.combine` does for Solcast arrays.
- Apply the AC clip to the summed kW.
- Cadence: reuse the store's rules (refresh after 3 h, usable for 6 h).
  Budget: at most 6 Forecast.Solar calls per rolling hour per device (half the
  IP limit, leaving room for other devices on the same network) and honour 429
  `Retry-After` / `message.ratelimit`.
- Horizon is today + tomorrow. Consumers already handle this: the estimator and
  bill projection fill beyond the forecast with history.

### 5. Correction

The layout's size and the forecast's absolute level drift (detected sizes run
high; shading is not in Forecast.Solar's model). Apply a per-site correction:

- The phone keeps the Forecast.Solar intervals it fetched for the last 14 days
  (small; same persisted state as the cache).
- The server already sends per-slot history; add (or extend) a field with the
  site's actual solar Wh per hour for the last 14 days.
- Correction = ratio of actual to forecast energy per local hour-of-day over
  the trailing 14 days, using only hours where both exist, clamped to 0.5-1.5,
  falling back to the all-day ratio for hours with too little data, and to 1.0
  with no history. Multiply forecasts by it.
- This is deliberately simple. It absorbs size bias and recurring shade; it
  cannot fix a bad weather forecast.

### 6. Provider selection and UI

- Per site: Solcast credential present → Solcast (unchanged). Otherwise,
  layout with confidence `high` or `medium` → Forecast.Solar. Otherwise no
  forecast and the existing `.failedWithBasic` / history path.
- Refactor the store so the provider is behind a protocol: today
  `SolarForecastManaging` and `SolarForecastStore` build `SolcastClient`
  directly and pass `SolcastForecastPoint`s around. The cache, budget and
  publish logic should hold provider-neutral intervals plus a provider tag, so
  Smart Shift needs no changes. Keep Solcast credential handling exactly as is.
- Settings sheet: a "Solar forecast" section shows the source in use
  ("Automatic (Forecast.Solar)" or "Solcast"), the detected layout in plain
  words ("2 panel faces: east-facing about 5 kW, west-facing about 6.5 kW"),
  its confidence, and the reason when there is no automatic forecast. Solcast
  setup stays below it as the alternative. Follow the app's voice guide.
- Attribution: name Forecast.Solar as the source where the forecast is shown.

### 7. Privacy

- Update the privacy page (`src/app/privacy/page.tsx`): rounded home location
  is stored on the server to detect the panel layout, and the phone sends the
  rounded location and panel geometry to Forecast.Solar.

## Rollout

1. Server: location storage, detector port with parity tests, cron, endpoint.
   Run on all sites with a location in Dev; review confidence spread.
2. iOS: provider refactor (no behaviour change), then Forecast.Solar client,
   correction, settings UI.
3. Ship behind a per-user flag until the forward comparison has 3-4 weeks of
   data. No flag mechanism exists yet: add a `User.roles` entry
   (`solar-forecast-beta`). It gates everything: the cron only detects for
   flagged users' sites, the mobile contract reports the flag so the phone
   only shows the location prompt and the automatic source to flagged users,
   and the layout endpoint returns `null` for everyone else.

## Provider decision rule (owner's call)

Ship Forecast.Solar if, over at least 20 scored days, its **day-ahead**
forecast beats today's history-only fallback on **both** daily-energy error
and hourly error. The history fallback is what Smart Shift uses without a
forecast: the median of the same local hour over the previous 14 days.
Otherwise, try Open-Meteo's forecast (tilted irradiance for the detected
planes, after checking its licence for PWUsage's use) against the same rule.
The forward capture (`.forecast-compare/score.py`) reports this baseline as
`history_14d_median`. Days with snow or outages are scored as they come; no
cherry-picking.

## Open risks

- **Forecast.Solar's accuracy may not be good enough.** The early capture shows
  large cloudy-day misses. Keep the provider seam clean so another free source
  (for example Open-Meteo's forecast API with its tilted-irradiance output,
  subject to its licence terms) can replace it without touching detection.
- Detection is expensive to port; parity tests against the Python reference
  are the guard.
- Heavy-shade sites with short history will not get a forecast at first.

## Left to the builder

- Table vs columns for the stored layout and location; exact endpoint shape.
- Solar-position and clear-sky algorithm choices, within the parity targets.
- How the 14-day forecast history is stored on the phone.
- Grid resolution and refinement strategy, within the 60 s limit.

## Calls I made (not discussed with the owner)

- TypeScript port over a Python function.
- 6-week minimum history; low confidence → no forecast rather than a generic
  layout.
- Correction by hour-of-day ratio over 14 days.
- Per-device budget of 6 calls/hour.
- User-entered layouts and paid Forecast.Solar keys are out of v1.
- Research sites' data never committed; CI parity uses synthetic fixtures.
- Parity bar is backtest error within 1 point, not exact geometry.
- Flag is a `User.roles` entry gating detection, prompt and endpoint.
- Multi-site location: selected site only, confirmed, with a solar-noon check.

Note on sequencing: the layout detector is provider-independent (any free
forecast, including Open-Meteo's tilted irradiance, needs the same planes), so
the server work can start before the provider question is settled.


**Server review status:** The original parity gate remains in force and is partially met, with the plane-count exception and pending owner acceptance documented in the [server plan](../plans/2026-10-27-auto-solar-forecast-server.md#review-follow-up-parity-status). Insufficient-history results retry after 24 hours; successful and low-confidence results retain their 30-day cadence.
