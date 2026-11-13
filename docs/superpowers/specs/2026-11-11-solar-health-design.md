# Solar health: manual layout and panel degradation detection

- **Date:** 2026-11-11
- **Status:** Draft for owner review. Decisions and the remaining questions are in the last section.
- **Area:** `cmd/ios-app` (layout record, history store, health pass, Solar System screen), one small change in `cmd/next-app` (`GET /api/mobile/solar-history`)
- **Related:** [on-device solar layout plan](../plans/2026-10-30-on-device-solar-layout.md), [auto solar forecast spec](./2026-10-27-auto-solar-forecast-design.md), [history onboarding design](../../plans/2026-11-02-history-onboarding-design.md), [`docs/voice-and-terms.md`](../../voice-and-terms.md)

## Summary

Both features are iOS work in `cmd/ios-app`: a manual layout the user enters, and degradation detection built on values the layout detector already computes and mostly discards.

The server stores no layout and no home location, so there is no schema change and no web UI. Storage is the local `SolarLayoutRecord` synced through the user's private CloudKit database.

The detector already has a clear-sky model, clear-day selection, clip detection and a learned shade mask. The new work is a manual layout record, keeping all history on the phone, and a health pass that recomputes fitted capacity and shading for every year from that history.

Checked against `KevM/pwusage` at commit `c0e55ba`.

## What the repo already provides

Most of the modelling exists. The gaps are persistence and history length.

| Need | Existing code | Gap |
| --- | --- | --- |
| Expected clear-sky power | `layoutSun`, `LayoutPOA`, `LayoutFit.modelRows` | None |
| Clear-day filter | `selectClearDays`, `SolarLayoutDetector.classifyDays` | None |
| Inverter clipping | `detectClip`, stored as `acClipKw` | None |
| Shading by sun position | `learnShade` returns a `ShadeMask`: a horizon per 10° of azimuth plus 10° by 5° hot bins | The mask is dropped. `DetectedSolarLayout` omits the shading profile |
| Capacity | `Plane.effectiveKw`, with `dcKwp = effectiveKw / 0.85` | `dcKwp` is an estimate, not nameplate |
| Uncertainty | `azimuthRange90`, `tiltRange90` from 20 bootstrap rounds | None |
| 5-minute history | `SolarHistoryStore`, `GET /api/mobile/solar-history` | Solar only. The fill request has no lookback limit, but the import stops at 365 days, the cache prunes at 400, and reads reject dates more than 400 days back |
| Storage and sync | `SolarLayoutRecord`, `SolarLayoutRecordStore`, `SolarLayoutCloudSync`, `SolarLayoutCloudMerge` | No manual fields |
| Weather | `OpenMeteoClient`, radiation columns only, `past_days=1` | No temperature, rain or snowfall |
| UI | `SolarSystemView`, `SolarSystemDetailsRows` | Read-only |
| Gating | Site access, enforced by the history endpoint | None |

Detection reruns every 30 days over a rolling 365-day window (`SolarLayoutDetectionSchedule`). The fitted capacity therefore drifts down with the panels, so health compares every year against one fixed reference instead of the latest fit.

## Goals and non-goals

Goals:

- Let users enter their exact setup: one or more systems, each with one or more faces, without losing the detected layout.
- Detect production loss on clear days and classify it as soiling, shading, aging or a step fault.
- Give an absolute health score when nameplate capacity is known.
- Keep false alarms low: no finding is shown without a minimum number of clear days behind it.
- Leave `SolarLayoutDetector.detect` output unchanged so the fixture parity suite still passes.

Non-goals:

- Web UI or server storage. The server holds no location by design.
- Panel-level diagnostics. The data is one solar series per site.
- Real-time alerts.
- Quantifying snow loss. Snow days are only excluded.
- Diagnosing hardware faults beyond flagging an abrupt, persistent drop.

## Feature A: Manual layout

A site holds one or more systems, and each system holds one or more faces. A system is one installation with its own age, panels and inverter. A face is one roof plane of that system.

| Level | Field | Required | Notes |
| --- | --- | --- | --- |
| System | Label | No | For example "Original 2016 install" |
| System | Install date | No | Month and year. Drives expected aging for that system |
| System | Inverter AC rating (kW) | No | Marks where that system clips |
| Face | Label | No | For example "South roof" |
| Face | Panel count | Yes | |
| Face | Panel wattage (W) | Yes | Per face, prefilled from the system's other faces. Older systems have lower wattage |
| Face | Azimuth (degrees) | No | Falls back to the detected value |
| Face | Tilt (degrees) | No | Falls back to the detected value |

Data model:

- Add a `ManualSolarLayout` type (`Codable`, `Sendable`) holding `systems`, each with `faces`.
- Add optional `manualLayout` and `manualSetAt` to `SolarLayoutRecord`. Optional fields keep stored records and older builds decoding.
- Sync `manualLayout` to CloudKit as JSON data, the way `result` is stored. In `SolarLayoutCloudMerge`, the later `manualSetAt` wins, as it does for location.
- A manual layout survives redetection, a detector version bump and a location change. Only the user clears it.
- A system counts toward nameplate only from its install date. That covers panels added later without a separate versioning scheme.

No limit on systems or faces:

- A manual layout holds any number of systems and faces. Nothing is merged or dropped.
- The three-plane limit belongs to the detector's fit, where more planes cannot be told apart from production alone. Entered faces are known, not fitted, so the limit does not apply.
- Expected production sums every entered face through the same plane-of-array model.
- `SolarLayout.init(from:)` and `OpenMeteoArrayModel.powerKw` both reject more than three planes today. Relax that check for layouts that come from manual entry. The detector's own output stays at one to three.
- Nameplate for the site is the sum of panel count times wattage over all faces of all systems installed at that date.

What consumes the manual layout:

- **Display.** `SolarSystemView` and `SolarSystemDetailsRows` show entered systems and faces in place of detected groups.
- **Health score.** Fitted capacity over nameplate, described under Gating.
- **Forecast.** Keep two models. Expected production uses entered geometry and nameplate. The operational forecast that Smart Shift relies on uses entered geometry with fitted capacity. `OpenMeteoArrayModel` multiplies `dcKwp` by a fixed 0.86, so nameplate gives what a healthy system would make. The gap between that and actual production is the finding shown to the user, while the fitted forecast stays accurate for battery decisions. With entered faces, fit one scale factor to the nameplate model on clear rows. That factor is the health score, and the forecast uses the entered faces times that factor.

On save, compare entered values with the detected result and flag disagreements. Flags are informational and never block the save.

- Entered azimuth or tilt falls more than 5° outside the detected plane's `azimuthRange90` or `tiltRange90`.
- The entered faces point in a different number of distinct directions than the detector found planes.
- Total fitted `effectiveKw` is outside 60–90% of nameplate. The detector's own derate assumption is 85%.

## Feature B: Degradation detection

The phone keeps all of a site's 5-minute history and recomputes the whole health picture from it. Nothing is pinned or carried forward, so there is nothing to reset.

1. **Keep all history on the phone.** Remove the 400-day prune in `SolarHistoryStore` and let the import continue past `SiteHistoryOnboarding.maxDaysBack` to the start of Tesla's history. A year is about 105,000 samples.
2. **Choose the reference.** With a manual layout, the reference is the entered faces at nameplate. Without one, it is the detected layout's geometry, scaled to the site's best year.
3. **Fit capacity per period.** For each year, and each month with enough clear days, fit a scale factor to the reference on clear rows. Fit one factor per direction where faces point far enough apart to separate, and one site-wide factor otherwise.
4. **Learn shade maps per season.** Run `learnShade` on the clear rows of each season of each year.
5. **Compute daily ratios.** Actual over reference for every clear day, for the soiling and step-fault rules.
6. **Classify.** Run the rules in the next section over the per-period factors, seasonal shade maps and daily ratios.

Recalculation and caching:

- Results are derived data. Cache them per completed year, keyed by the reference layout and detector version.
- A normal run recomputes only the current year. Changing the manual layout, the location or the detector version recomputes every year.
- Nothing derived is synced. Each device rebuilds from the same history and gets the same answer.
- The store is one JSON file per site, decoded whole. Split it by year or use a compact binary form so loading stays fast with many years.
- The pass runs in the foreground or a background task and must stay cancellable, like detection.

Getting the history:

- The import already reaches back in 3-day slices through `POST /api/mobile/solar-history`, in the foreground or in the `fm.rodeo.pwusage.history-onboarding` background task. The fill has no lookback limit.
- When the user chooses to load more history, continue the same walk to `reachedHistoryStart`, honouring the same Tesla throttle waits.
- Show progress in the tab bar accessory (`tabViewBottomAccessory` in `AppTabView`, drawn by `SolarSystemBanner`), with its own wording so it is not mistaken for the layout import.
- Remove the 400-day check on `GET /api/mobile/solar-history` (`MAX_DAYS_BACK`). It was sized for layout detection's 365-day window. Without it a second device or a reinstall reads the full history from the server instead of refilling from Tesla.
- Every filled day is stored on the server in `EnergyDayArchive` with daily totals in `EnergyDaySummary`. The same walk builds the daily history a future return-on-investment feature needs.

A step up in fitted capacity means panels were added. With a manual layout, the reference at each date includes only the systems installed by then. Without one, treat an upward step as a capacity change and start the trend after it.

## Cause classification

Each cause leaves a different pattern in the daily ratio, the fitted capacity per period and the seasonal shade maps. All thresholds are starting values to tune against real data.

| Cause | Signature | Source | Detection rule | Minimum evidence |
| --- | --- | --- | --- | --- |
| Shading now | Deficit tied to sun position | Current `ShadeMask` | Horizon segments from `ShadeMask.summary()` and any hot bins | Already enforced by `learnShade` (20 samples per bin, 4 days per hot bin) |
| Shading growth | The shaded region rises or widens | Seasonal shade maps across years | A horizon bin is 5° or more higher than in the same season a year earlier | The same season in two years |
| Soiling | Uniform drop, gradual, then a step back up | Daily ratios, current year | Ratio trends down across consecutive clear days, then rises 2% or more after a cloudy gap | 5 clear days before the step |
| Aging | Slow, uniform decline | Fitted capacity per month and year | Median change between the same calendar month a year apart, reported as % per year | 13 months for a first estimate, 24 for a confident one |
| Step fault | Abrupt, persistent drop | Daily ratios, current year | Ratio falls 10% or more and stays down | 3 clear days after the drop |
| Snow | Near-zero output, then recovery | Day classification | Already excluded as `noProduction` days or gross outliers | Excluded, not reported |

Every finding carries the number of clear days behind it and a confidence level. Findings below minimum evidence are stored but not shown.

Shade maps are learned per season because trees that drop their leaves shade heavily in summer and lightly in winter. One map for the whole year would blur the two, and each spring's leaf-out would look like new growth. Comparing summer with summer shows only real change, and lets a finding say "shaded in summer only."

## Confounders

Six effects can look like degradation. Three are already handled by the detector.

| Confounder | Effect | Handling |
| --- | --- | --- |
| Inverter clipping | Flat midday output hides losses | Handled. The model applies `clipKw` and `flatRuns` drops plateau rows |
| Snow and gross outliers | Near-zero or wildly low rows | Handled. The keep mask drops rows more than 15% of peak away from the model |
| Wrong location | Model and production disagree all day | Handled. The detector measures longitude error and lowers confidence |
| Temperature | Hot panels produce less, so summer ratios run lower | The clear-sky model appears to have no temperature term. Compare the same calendar month across years, which cancels it without weather data |
| Curtailment | A full battery with limited export reduces solar | This is the inverter throttling healthy panels because the power has nowhere to go. Only short flat runs are caught today. Telling it apart from a real loss needs the battery level and export for the same moments, which the server has but does not send to the phone |
| Smoke and haze | Clear-looking days with reduced irradiance read as soiling | Require several consecutive clear days before a soiling finding |

Weather history sharpens three rules, and none of them depend on it:

- **Rain** confirms soiling. A ratio that jumps back right after rain was dirt or pollen being washed off.
- **Snowfall** marks days when panels were covered, so they are excluded with certainty instead of by inference.
- **Temperature** removes the summer dip that hot panels cause, so months can be compared directly.

`OpenMeteoClient` requests three radiation columns with one past day today. Past years need Open-Meteo's historical service, crawled once per site in long date ranges. A full crawl is a handful of requests per site from the user's own phone, far inside the 10,000 daily calls the free tier allows. Weather stays the last phase because nothing else depends on it.

## Gating

Trend detection works for everyone with a detected layout. Anything needing an absolute reference requires a manual layout. Both require access to the site.

| Capability | Detected layout | Manual layout |
| --- | --- | --- |
| Current shading | Yes | Yes |
| Shading growth | Yes | Yes |
| Soiling trend | Yes | Yes |
| Year-over-year decline | Yes | Yes |
| Absolute health score | No | Yes, needs panel count and wattage |
| Decline compared with expected aging | No | Yes, needs install dates |
| Entered vs detected mismatch | No | Yes |

The health score is the fitted scale factor: clear-day production divided by what the entered faces should produce at nameplate. The detector assumes 85% for a healthy system. Show the score with a ±5–10% band, and raise a finding from the score alone only when it falls well below that range.

Report health per direction wherever the fit can separate the faces, such as an east roof and a west roof. Faces pointing the same way share one number, because their production cannot be told apart.

Expected aging is computed per system from its install date at about 0.5% per year, then weighted by each system's share of nameplate. A site with a 2016 system and a 2023 addition gets one blended expectation.

Expected versus actual is the headline of the feature. With nameplate known, each clear day has an expected energy from the clear-sky model, so the app can say "a system like yours should make 42 kWh on a day like this, and yours made 35." The full history then shows how that gap has changed over the system's recorded life, and the classification rules say why.

## UI surfaces

All surfaces live in the iOS Solar System screen (`Views/SolarSystem/`). Copy follows `docs/voice-and-terms.md`.

Placement: health is part of Settings, Solar System, not a separate screen or a notice elsewhere. Once onboarding finishes and a layout is detected, the house model and the stats under it start reflecting health. There is no card on the Home tab.

Stats under the house, added to the configuration rows already there:

- **Potential vs actual.** What the system should produce on a clear day and what it does, with the difference.
- **Shading.** Which directions and seasons lose sun, and whether it has grown.
- **Dirt level.** The current soiling loss and when output last recovered.
- **Change over time.** Fitted capacity by year, once more history is loaded.

Loading more history is the user's choice. The year gathered for layout detection supports potential vs actual, current shading and dirt level. A "load more history" action on this screen starts the full walk and unlocks change over time, and later ROI.

Solar System may later become its own tab as it gains ROI, health and forecast views. Build for that now: give the Solar System area its own destination type instead of adding cases to `SettingsDestination`, and have the tab bar accessory open it through one routing function. Promotion is then a change to where the root is mounted, not to the screens.

- **Layout editor.** Reached from `SolarSystemDetailsRows`. A list of systems, each expanding to its faces. Detected values prefill azimuth and tilt.
- **Save comparison.** Entered and detected values side by side, with any mismatch flags.
- **Details rows.** Show entered systems and faces when a manual layout exists, and mark them as entered rather than detected.
- **Health card.** Shows the capacity your production implies beside the capacity you entered, and the difference, with its band. Under it, fitted capacity over time from the full history: a slow slide reads as degradation, and dips at the same sun positions on clear days read as shading. Without a manual layout, the card says what entering panel count and wattage unlocks.
- **Shade view.** The horizon profile and hot bins by sun direction. `SolarSystemScene` already draws the house, its panel groups and a direction wedge, so shaded directions could be drawn there.
- **Ratio trend.** Monthly fitted capacity, plus daily clear-day ratio for the current year.
- **Findings list.** Plain-language findings such as "Output is lower when the sun is low in the east, consistent with shading." Each shows its confidence and clear-day count.

The tab bar accessory tells the user when older history is being checked for panel health, as it does today for the layout import.

The house model is the main display of health. `SolarSystemHouseDrawing` already builds the house and places panels face by face, so health can be drawn on it:

- **Shading on the roof.** Darken the faces that are shaded for the selected season and time of day, with a scrubber to move the sun.
- **Dirt over time.** Tint panels as the soiling ratio falls through a dry spell and clear the tint when it recovers.
- **Aging over years.** A year scrubber fades each face by its fitted factor for that year.
- **Entered faces.** With a manual layout, draw the real systems and faces instead of the stand-in groups.

The data is one production series for the whole site, so the drawing is accurate per face and per sun direction, not per panel. It can show that the east roof loses the morning sun in summer, but not which three panels the tree covers.

## Implementation phases

Build in seven phases, each shippable on its own. Tests use Swift Testing and run through `cmd/ios-app/run-tests.sh`.

1. **Manual layout record and sync.**
   - A record stored before this change decodes with `manualLayout` nil.
   - CloudKit round-trips a layout with three systems and eight faces.
   - Merge keeps the layout with the later `manualSetAt`.
   - Redetection and a location change leave the manual layout untouched.
2. **Layout editor and save comparison.**
   - Two systems with different panel wattages produce the correct nameplate total.
   - Faces pointing the same way in different systems stay separate and sum in the model.
   - `OpenMeteoArrayModel` accepts more than three planes from a manual layout.
   - Each of the three mismatch flags has a test.
3. **Full history on the phone.**
   - After the user chooses to load more history, the import continues past 365 days to `reachedHistoryStart`, and the store keeps every day.
   - The tab bar accessory shows while it runs and clears when it ends.
   - `GET /api/mobile/solar-history` serves dates more than 400 days back.
   - Loading a ten-year store stays within a set time budget.
4. **Health pass.**
   - `SolarLayoutDetectorFixtureParityTests` and `SolarLayoutClearDaysParityTests` pass unchanged.
   - A healthy synthetic site gives a factor near 1.00 for every year.
   - East and west faces get separate factors. Two south faces share one.
   - Changing the manual layout recomputes every year. A normal run recomputes only the current one.
5. **Classification and health stats in Solar System.**
   - A year with a 5% uniform loss that recovers is classified as soiling.
   - A horizon raised in summer only is reported as summer shading at the right azimuth, and is not reported as growth the next spring.
   - A 1% per year decline over five years is measured within ±0.3 points.
   - A clean site produces no findings.
   - With one year of history the stats show potential vs actual, shading and dirt level, and offer to load more for change over time.
6. **House view.**
   - Shaded faces darken for the selected season and time.
   - Entered faces are drawn in place of the stand-in groups.
7. **Weather history.**
   - A soiling finding followed by rain is marked confirmed.
   - Days with snowfall are excluded.

Phases 4 and 5 are tested with made-up production data that has a known problem built in, such as exactly 5% dirt loss or a tree at 100° azimuth. Real data cannot do this, because nobody knows the true answer for a real roof. The generator is a Swift test helper, since the TypeScript one was removed with `src/lib/solar-layout`.

## Decisions and open questions

Decided on 2026-11-11:

- Manual entry has no limit on systems or faces.
- The phone keeps all history and recomputes health from it. There is no pinned baseline.
- Health is reported per direction where the data can separate faces.
- Shade maps are learned per season.
- Health data is computed on each device and not shared between household members.
- Health is shown inside Settings, Solar System, on the house model and its stats, with no Home card. It is built so Solar System can become its own tab.
- Synthetic test data comes from a Swift test helper.
- Loading history beyond the detection year is the user's choice, made from the Solar System screen.
- The Smart Shift forecast uses fitted capacity, because it is the more accurate prediction of real output. Nameplate is used only for the potential figure in the health stats.
- A subtle marker on the Solar System row in Settings signals a new finding.
- Weather history uses Open-Meteo's free API, which the owner has confirmed fits because the app is free: no key, up to 10,000 calls a day for non-commercial use, attribution required under CC BY 4.0. The app's existing `SolarForecastAttributionView` covers attribution.
- No sites with export limits or off-grid setups are known. Curtailment handling is deferred until one shows up as a false finding.

Still open:

- [ ] How long should the new-finding marker stay: until the screen is opened, or until the finding clears?
- [ ] Confirm the historical endpoint's variables for rain, snowfall and temperature before phase 7.
