# Solar System Experience Implementation Plan

**Goal:** Replace Site History's text with a visual story of finding the user's solar system. Downloaded days stream into a calendar strip, clear days fly into a compass and narrow its wedge, and the detected layout appears as a house the user can rotate. One Solar System screen holds this view, the system details and the home location, merging Site History and Solar Forecast. The tab-bar banner tells the same story in miniature.

**Architecture:** Onboarding gains a cheap clear-day pass that runs often and saves each day's type, and runs full detection only when a target is crossed. A small status model feeds pure-Swift geometry: the strip layout, the compass wedge and a hand-rolled orthographic projection of a hip roof. A SwiftUI `Canvas` draws that geometry, driven by a `TimelineView`. Nothing new goes to the server.

**Tech stack:** SwiftUI (`Canvas`, `TimelineView`, `tabViewBottomAccessory`), Swift concurrency, Swift Testing.

**Builds on:** `docs/plans/2026-11-02-history-onboarding-design.md` (the onboarding job, lifecycle and Settings work in PR #285).

**Reference prototypes:** `docs/plans/prototypes/solar-system-reveal.html` (strip, flights melting into rays, wedge, house build) and `docs/plans/prototypes/solar-system-banner.html` (the banner). Open them in a browser and match their timing, easing, flight curves, colors and layout in SwiftUI. Where the plan and a prototype differ, the plan wins (for example, the banner's dot colors and the needs-location state).

## Decisions

- **Targets the user sees.** These are the detector's existing thresholds; none of them change:
  - 42 producing days before it tries;
  - 15 clear days for a usable (medium) layout;
  - 40 clear days, 180 producing days and a direction range within 30° for high confidence.
- **Loading continues toward high confidence.** Forecasting uses the layout as soon as it's usable; loading keeps going until high confidence, one year, the history start, or a problem more history won't fix. Reaching 180 producing days means about six months, so most sites now load at least half a year, at a few hundred more Tesla requests per site.
- **Two passes:**
  - The clear-day pass runs after every second slice (six days), except that a layout already at high confidence runs it once, when it stops after the recent days. It sorts days into clear, cloudy and no production, and saves the result. It never writes the layout record, so nothing syncs through iCloud.
  - Full detection runs when the clear-day count first crosses 15 or 40, or producing days cross 180, with a fallback every 30 checked days. Each full run saves the layout record, as now.
- **What the wedge means.** Before the first fit, its width is a stylized function of the clear-day count and doesn't claim to be a measured range. Once a fit exists, the width is the largest plane's `azimuthRange90`.
- **What the house means.** The house is a neutral stand-in; nothing claims it's their roof:
  - It has a hip roof, scaled by total kW within limits.
  - The largest panel group takes the front face, and each other group takes the face nearest its direction.
  - The panel count is size ÷ 0.4 kW. The roof pitch is the largest group's tilt.
- **Counts come from what's on the phone.** Days downloaded, producing days and clear days all count the phone's stored history. The onboarding position stays internal, so a resync can never make the screen disagree with what the detector used (the "42 checked, 121 producing" confusion).
- **Wording.** "Finding your solar system". The Settings row and screen are titled "Solar System".
- **Forecast credit.** It moves from Settings to About as a "Data sources" line. The "Forecast by Open-Meteo" line stays on Smart Shift and Bill, where forecast data appears.
- **Colors** match everywhere: grey for downloaded but not yet sorted, blue for cloudy, amber for clear, a faint dashed ring for no production. The strip, banner and flying dots all use them.

## Experience

1. **While loading:**
   - A compass and a calendar strip (columns are weeks, rows are weekdays, newest week on the right).
   - The strip starts as one centered column and widens as older weeks arrive. Days not yet loaded aren't drawn.
   - Month labels fade in above the strip as each month's first day arrives, and the year is labeled at January and at the newest end.
   - A newly loaded day grows in. At each clear-day pass, days take their colors.
   - Clear days fly to the compass rim and stretch inward into a ray, narrowing the amber wedge.
   - The compass sits well clear of the strip.
2. **When a layout is found:**
   - The wedge closes to a single direction and the camera tilts down.
   - The house rises, the roof pitches to the detected tilt, and panels drop in face by face.
   - The strip fades away as the camera tilts. The house sways gently and can be dragged to rotate.
3. **Below the visual:**
   - A one-line status, with an action button only when one is needed: Add Location, Reconnect Tesla, or Use My Exact Home Location. Add Location opens the home location sheet (Task 8).
   - A system details card: total size, then each panel group's size, direction, tilt and confidence.
   - Home location: exact or estimated, with an update option.
   - In Debug builds, the Debug section from PR #285.
4. **Tapping a day** shows a small callout with its date and type ("Oct 14 · clear"), using the same colors.
5. **Banner:**
   - Above the tab bar: a tiny compass, "Finding your solar system", the day count, and a track on the right where a dot glides in for each downloaded day. Dots arrive in threes; at each pass the clear ones turn amber and arc into the compass.
   - Inline: just the compass and the dots.
   - With no location: a location pin and "Add your location to find your solar system". Tapping opens the screen at the location step.
   - While waiting out a Tesla limit, the dots stop and the compass dims.
6. **Reduce Motion:** no flights, drops or sway. States change in place, and the finished house appears without the build-up.
7. **VoiceOver:**
   - One summary element, for example "Finding your solar system. 96 days downloaded, 21 clear. Usable, still improving."
   - When found: "Solar system: 8.8 kilowatts, two panel groups, main group facing south-southwest, tilted 22 degrees, medium confidence."
   - The strip is one adjustable element that steps through weeks.

---

### Task 1: Clear-day pass

**Modify:** `PWUsage/Models/Solar/LayoutDetection/solar-layout-detector.swift`, `solar-layout-detector-support.swift`, `solar-layout-readiness.swift`.
**Test:** a new `PWUsageTests/SolarLayoutClearDaysTests.swift`; existing detector parity suites.

1. Write failing tests:
   - The pass returns each site-local day as clear, cloudy or no production.
   - Its clear set equals `stages.clearDays` from a full `detect` run on the same samples (fixture parity).
   - It returns nothing without a location, and handles daylight-saving days.
2. Extract the detector's stages up to `clearDaySets` into `SolarLayoutDetector.classifyDays(samples:latitude:longitude:timeZone:)`, used by both the pass and `detect`, so the two can't drift. Detector output and its parity with the TypeScript reference stay unchanged.
3. In Debug builds, log the pass's duration (signpost and `Logger`). Record the duration on an iPhone 18 Pro and the oldest phone available, with a year of history, and pick the pass cadence from the result (default: every second slice).
4. Run the targeted suites and the full default iOS suite (fixture parity lives in skipped-in-quick suites).

### Task 2: Day ledger and checkpoint record

**Create:** `PWUsage/State/Solar/site-history-day-ledger.swift` (store) and its tests.
**Modify:** `SolarSessionCleanup` (remove on sign-out), the Debug reset (`site-history-debug.swift`).

1. Test:
   - The ledger stores one compact entry per site-local day for each account and site.
   - It reloads after a relaunch.
   - Sign-out clears it, and the Debug reset clears only the selected site.
   - A year fits in a few kilobytes.
   - It's excluded from backup and uses the same file protection as the onboarding store.
2. Store, per scope, the latest pass's day types and a checkpoint record: when it ran, producing and clear counts, and the fitted `azimuthRange90` when a fit ran. Don't duplicate samples: the history store stays the source of readings.

### Task 3: Onboarding cadence and stop rules

**Modify:** `PWUsage/State/Solar/site-history-onboarding.swift`, `site-history-onboarding-environment.swift`.
**Test:** `PWUsageTests/SiteHistoryOnboardingTests.swift`.

1. Write failing tests:
   - The pass runs after every second complete slice and writes the ledger.
   - Full detection runs only on the first crossing of 15 clear, 40 clear or 180 producing days, plus every 30 checked days.
   - A usable layout no longer stops loading. High confidence, the bound, or `needsOtherAction` stops it.
   - With no location, loading still stops at 90 days with `locationNeeded`, with no pass and no ledger colors.
   - An existing high-confidence layout stops after the recent days. An existing medium layout keeps going toward high.
2. Add `classifyDays` to the environment protocol. Replace the checked-days checkpoint schedule with pass-driven thresholds. Keep cancellation, the account throttle and the "cancelled attempts don't save" rule exactly as they are.
3. Update the "Implemented on-device job" section of the onboarding design doc.

### Task 4: Status model for the visuals

**Modify:** `PWUsage/State/Solar/site-history-status.swift`, `site-history-onboarding-lifecycle.swift` (`refreshStatus`), `PWUsage/Views/Settings/site-history-presentation.swift`.
**Test:** `SiteHistoryPresentationTests`, `SiteHistoryOnboardingLifecycleTests`.

1. Extend `SiteHistoryStatus` with:
   - day entries (date and type) for the strip;
   - downloaded, producing and clear counts from the phone's history and ledger;
   - the wedge source (stylized from the clear count, or the fit's range);
   - the stored layout's panel groups and confidence;
   - the location state: none, estimated or exact.
2. Rework the presentation into a phase: loading, waiting, needs location, needs reconnect, found and improving, found and final, or unavailable. Give it the one status line, an optional action, and the VoiceOver summary. Remove the checked-days text.
3. Test that the counts never come from the onboarding position, and that one site's status never shows on another.

### Task 5: Geometry, pure and tested

**Create:** `PWUsage/Views/SolarSystem/solar-system-geometry.swift` and `PWUsageTests/SolarSystemGeometryTests.swift`.

1. Write pure functions and test them:
   - **Strip layout:** week columns, weekday rows, centering as weeks are added, month and year label placement with collision skipping, and wrapping into two bands on narrow widths.
   - **Wedge width:** stylized curve until a fit, then the fitted range.
   - **Hip roof:** the four faces' polygons for a footprint scaled by kW, each panel group placed on its face, and panel rectangles that fit inside the face.
   - **Projection:** orthographic, from yaw and elevation, plus back-face visibility (the house is convex, so no depth sorting is needed).
2. The house is a stand-in. Tests check orientation and fit, not realism.

### Task 6: Solar System screen

**Create:** `PWUsage/Views/SolarSystem/solar-system-view.swift`, `solar-system-scene.swift` (the `Canvas` and `TimelineView` scene), `solar-system-day-strip.swift`, `solar-system-details-card.swift`.
**Modify:** `PWUsage/Views/Settings/settings-view.swift` (one Solar System row replaces Solar Forecast and Site History), `SettingsDestination`, `PWUsage/Views/Settings/about-sheet.swift` (data sources), `PWUsage/Navigation/app-tab-view.swift` (routes).
**Retire:** `site-history-view.swift`. Fold `SolarForecastAutomaticSection`'s location button and its outcome into the screen, keeping `solarLocationConfirmation` and its flow as they are.

1. **Scene:**
   - Phases are driven by the status and by animation clocks recorded when a pass or fit lands, so a relaunch shows the current state without replaying the history.
   - A flight starts from its day's strip cell and ends on the rim.
   - Dragging rotates the house's yaw, with the elevation clamped.
2. **Strip:** tapping a day shows a callout, and VoiceOver can step through the weeks.
3. **Details card:** size, direction (as a compass word plus degrees), tilt and confidence for each panel group. While improving, it says so in a single word, with no paragraph.
4. **Location section:** exact or estimated, with an update option. The Add Location action is shared with the status line.
5. **Reduce Motion, Dynamic Type, dark mode and the iPad sidebar:** check each.

### Task 7: Banner

**Create:** `PWUsage/Views/SolarSystem/solar-system-banner.swift`.
**Modify:** `app-tab-view.swift` (accessory content), `PWUsageAppModel.openSiteHistory` (rename to `openSolarSystem`, with an optional location focus).

1. Build the expanded and inline layouts using the `tabViewBottomAccessoryPlacement` environment value. A dot arrives for each newly downloaded day, which needs a cheap "days on the phone" count in the status. Recolor at each pass.
2. Show it while loading or waiting, and in the needs-location state. Hide it when finished, paused for reconnect (Settings shows the action), or in the demo.
3. Keep it cheap: animate only while the app is in the foreground and loading. Reduce Motion gets a static compass and count.

### Task 8: Home location sheet

**Create:** `PWUsage/Views/SolarSystem/home-location-sheet.swift`, a search model wrapping `MKLocalSearchCompleter` and `MKLocalSearch`, and tests for the model and the location save.
**Modify:** `PWUsage/Models/Solar/mobile-solar-layout.swift` (`SolarLocationSource`), `PWUsage/Views/Solar/solar-location-invitation.swift`, `SolarLayoutRecordStore.setLocation` callers, and the Solar System screen's and banner's Add Location actions.

1. **One sheet, three ways to set the home location.** Use My Current Location is offered as "I'm at home now".
   - **Current location:** keep today's one-time reading (`DeviceHomeLocationProvider`). iOS offers "Allow Once", so no lasting permission is needed.
   - **Search:** address or ZIP code suggestions as the user types, resolved to coordinates, with no location permission.
   - **Map:** a fixed center pin that the user drags the map under, starting from the search result or the device's region, then confirms.
2. **Saving:**
   - All three go through `setLocation`, rounded to hundredths (about 1 km) and stored on the device only, as now. A ZIP code's precision is plenty: detection needs only roughly the right sun position.
   - Add `searched` and `map` to `SolarLocationSource`. Existing records decode unchanged.
   - Changing the location still clears a result fitted for the old one.
3. **Privacy:** state in the sheet that a search query goes to Apple. The location never leaves the device except through the existing iCloud layout sync.
4. **Tests:**
   - Search results map to the rounded location with the right source.
   - Each path saves the location and doesn't touch other sites.
   - Older records still decode.
   - VoiceOver and Dynamic Type work in the sheet.

### Task 9: Verification

1. Run the unit suites for each task, the full default iOS suite, strict SwiftLint, swiftformat, and a Release build.
2. On the simulator, check the loading, waiting, needs-location, found-and-improving and found-and-final states with seeded status, in light and dark mode, at large text, and with Reduce Motion.
3. Real device against Beta (`cmd/next-app/scripts/dev-history-reset.md`):
   - Reset one Dev site and watch it load from empty, including after backgrounding and a relaunch.
   - Confirm the pass cadence and its timing in the Debug logs, and that loading reaches high confidence or a bound.
   - Restore the site afterwards.
4. Update this plan's tracker in `task.md` and the design doc's "Implemented …" sections.

## Out of scope

- Server changes: the fill contract is unchanged.
- Drawing the user's actual roof shape.
- Visuals for the other features discussed: today's solar curve, the rate-day ring and the Smart Shift bank gauge.

## Found while nobody was watching

Agreed with the owner on 2026-11-06. Detection can finish in the background or on another tab, and the first look at the screen deliberately replays nothing, so that person would never see the find. Now a find they missed waits for them.

- **What owes a reveal.** Detection on this phone saves a usable layout (medium or high) for a site with none. That is the first usable layout, not the end of the search, because it is when the house appears and forecasting starts using it. Improving a layout owes nothing. A layout from iCloud never does, because it was not found here; that covers sign-in, reinstall and a new detector version.
- **Banner.** It shows "Found your solar system" and "8.8 kW · facing south-southwest" (inline, "Solar system found") with the compass closed on the direction found. It stays until Solar System is opened, by any route, and has no dismiss. It never shows in the demo, and iOS before 26.1 has no accessory, so those phones get the reveal only.
- **Reveal, about 11 s, once the screen is visible and the app active.** The strip grows out from the newest week (1 s), days take their colors in one sweep (1 s), and every clear day flies within 2.5 s however many there are, narrowing the wedge. The tilt and house then play as they do live. It does not assume days were sorted gradually, since an already-high layout sorts once at the finish. A tap skips to the finished house. The screen scrolls to the visual first, however the reveal was reached, because it keeps its scroll position between visits.
- **Seen.** Once the house starts to rise, on a skip, or at once under Reduce Motion, where the finished house shows in place. Leaving sooner keeps it owed, so the banner comes back. Someone watching when the layout is found gets the live animation, and that counts.
- **Storage.** `SolarLayout-reveals.json`, beside the layout records and never inside one, so iCloud cannot carry it; excluded from backup; per account and site. Sign-out and Debug's Reset clear it. Changing the home location clears the layout and the owed reveal, and finding it again celebrates again.
- **Not included.** Push notifications, catching up on a search still in progress, and announcing a search that ended without a result.
- **Debug.** Ignore Existing Layout hides only layouts from before it was turned on, so a rerun shows what it finds instead of "Not enough clear days". Reset moves that moment forward. Replay Reveal owes the reveal again for the stored layout.
