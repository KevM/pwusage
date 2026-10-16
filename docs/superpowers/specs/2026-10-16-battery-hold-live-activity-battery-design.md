# Battery hold Live Activity: drawn battery, live charge, branded glyph

Date: 2026-10-16. Branch: `claude/live-activity-ios-e66faa` (the iOS Live
Activity work, not yet merged to `main`).

## Why

The current Live Activity is accurate but lifeless, and one part of it misleads:

- Its icon is the system symbol `bolt.batteryblock`. The symbol's drawn fill is
  part of the artwork, so it never matches the level being held ("Holding at
  74%" next to a battery that looks half full).
- "Safety stop by 3:21 PM" fills a line that rarely matters early in a hold.
- For the first check cycle (up to 15 minutes) it says "Waiting for the first
  home load check." and shows no figures, even though the server measured the
  home load and battery charge at the moment the hold started.
- Nothing on it says "pwusage".

The user wants the activity to carry more life: show the battery itself, both
the held reserve and the actual charge, the home's current load, and a subtle
pwusage brand mark.

## Goals

1. The Lock Screen card's background *is* the battery: a faint battery outline
   with the current charge as a fill and the held reserve as a marked line.
2. The Dynamic Island shows a small version of the same drawn battery.
3. The activity shows the battery's live charge and the home's current load,
   from the first frame onward, refreshed on every monitor check.
4. A monochrome pwusage glyph brands the activity.
5. The safety deadline appears only once it is near.

## Non-goals

- No push-to-start, no change to how activities are started, ended, registered
  or delivered (APNs cadence stays as it is).
- No change to hold detection or restore logic. Detection keeps using the
  five-minute history samples it uses today.
- No change to Control Center's control glyph (it stays `bolt.batteryblock`;
  see the memory note on Control Center artwork caching).
- No new app accent color. The accent is whatever the app already resolves to.

## Anti-goals (failure even if it "works")

- A fill or number that implies precision or freshness the data doesn't have.
  An unknown charge is drawn as *no fill*, never as full or as the hold level
  (same rule as commit 77ae406, "draw an unknown battery charge as blank, not
  full").
- A hold line that disappears into the fill at small sizes.
- Busy decoration. The fill is subtle (low-opacity green); text stays the
  primary read.
- Any regression of the existing honesty rules in
  `BatteryHoldActivityPresentation`: absolute times instead of counting timers,
  "home load" rather than claims about a car, an explicit overdue state.

## Decisions the user made

These come from the 2026-10-16 brainstorm, with browser mockups.

**Lock Screen layout: "B, the battery outline inside the card".**
- A faint battery outline inset in the card (about 8pt from the top, bottom and
  leading edges, about 18pt from the trailing edge), with rounded corners and a
  small terminal nub centered on the trailing side, outside the outline.
- Inside the outline, a low-opacity green fill from the leading edge to the
  **current battery charge**.
- A **dashed** vertical line in the **accent color** at the **held reserve**
  (`targetReserve`), running the full height of the outline.
- Text sits on top, unchanged in structure:
  - Row 1: the pwusage glyph and the site name, both in the accent color.
  - Headline: "Holding at 74%" in the accent color.
  - Detail: the battery percentage leads, e.g. "Battery 82% · watching home
    load." (this keeps the headline from wrapping).
  - Load line: today's home load line from 981c49f, unchanged in shape:
    "Home 1.8 kW at 3:16 PM · started 1.6 kW · peak 7.2 kW".
  - Last line: today's deadline · checked line, which without the safety stop
    is just "Checked 3:30 PM". (The mockups abbreviated these two lines into
    one. The real layout keeps the two existing lines.)
- In the mockups this was the user's layout "3": glyph, site name and headline
  all in the accent color.

**Both levels at once.** The fill is the live charge and the line is the hold.
With solar the charge can rise above the hold, so the fill runs past the line.

**Glyph.** A hollow Powerwall (rounded rectangle outline) with a solid
lightning bolt, surrounded by eight sun rays: long rays at 0°, 90°, 180° and
270°, short rays on the 45° diagonals. The source vector is
[`assets/pwusage-glyph.svg`](assets/pwusage-glyph.svg) (24×24, `currentColor`,
every stroke and cap inside the box). The user approved its proportions ("I
like the size of things").

**Dynamic Island: option "C".**
- Compact leading: the pwusage glyph in the accent color.
- Compact trailing: the mini drawn battery only, with no number.
- Minimal: the mini drawn battery.
- Expanded: glyph and "Holding at 74%" in the accent color on the leading side,
  the site name on the trailing side; in the bottom region a full-width drawn
  battery bar (fill plus the dashed accent hold line), then the detail and the
  home load line as on the Lock Screen.
- At compact and minimal size, dashes vanish and an 82%-vs-74% gap is about
  2pt. So the mini battery's hold mark is a **solid** accent tick that extends
  a couple of points above and below the outline. The expanded bar is large
  enough for the dashed line.

**Live status per check.** The user approved one Tesla `live_status` call per
15-minute monitor check while a hold is active. (The user has been told Tesla
does not currently charge for Energy API calls. Use the existing
cache-and-claim path anyway.)

## Calls I made (the user can veto them)

- **Safety stop timing.** For Auto holds, "Safety stop by …" is hidden until the
  last 60 minutes before `safetyExpiresAt`, then it shows where it does today.
  Timer holds keep "Stops 3:21 PM" at all times, because for them the stop time
  *is* the plan.
- **Data source for the current load.** When a check gets a live status, the
  home load line uses its `load_power` and its `timestamp` (truly current).
  Without one, it falls back to today's latest five-minute sample. The peak
  stays computed from the five-minute history samples, as now. Detection is
  untouched.
- **Seeding at start.** The hold-start path (`parkBattery` in
  `battery-hold-service.ts`) already calls `getLiveStatus` (for SOC and
  baseline load). It writes an initial `monitoring` snapshot with the battery
  percent and home load from that call, so the app's first content state and
  the first push carry real figures. The seed's phase is `watching` for Auto
  holds: the load has been observed and equals the baseline, which is exactly
  what `watching` means. Timer holds get `timer`. The detail then reads
  "Battery 74% · watching home load." instead of "Waiting for the first home
  load check." The park route must return the hold *with* this monitoring
  (today it returns `createHold`'s row, which has none), so the app's first
  `ContentState(hold:)` sees it.
- **`waiting_for_data` keeps its warning.** A monitor check that finds history
  more than 20 minutes old still reads "Waiting for usage data. The hold is
  still active.", with "Battery N% · " prefixed when a live charge is known.
  Live figures must never mask a history outage, because Auto detection can't
  restore anything without history.
- **Peak vs live load.** When a live load is present, `peak_load_w` is the max
  of the history peak and the live load, so the line never shows a current
  load above its "peak". Phase and `estimated_load_w` stay history-based,
  since detection is unchanged. A brief "Home load is running." beside a lower
  live reading is acceptable: the phase copy describes the detector's view.
- **Live status age.** The monitor calls `refreshLiveStatus` with a short
  `cacheTtlMs` (about 2 minutes), not the 16-minute default. It reuses a
  dashboard refresh from moments earlier but never the previous check's
  status. The battery percent and the home load share the live timestamp
  shown in the load line ("Home 1.8 kW at 3:30 PM").
- **Final states** (restored, cancelled, ended). The outline and the fill at the
  last known charge stay, drawn more faintly, and the hold line is removed (the
  hold is over).
- **Stale states.** When the activity is stale, the fill and line stay, but the
  fill is drawn in a neutral, non-green tint, and the existing orange "Update
  overdue" detail still shows. A stale green fill reads as fresh.
- **Unknown charge.** Draw the outline and the hold line, with no fill. The
  detail omits the "Battery N%" prefix.
- **Rounding.** Battery percent is shown as a whole number (`percentage_charged`
  is fractional). The fill uses the unrounded value clamped to 0…100.
- **Light appearance.** The mockups were dark. The outline, nub and neutral
  tints use semantic/adaptive colors so the card works on a light Lock Screen.
  Green is the system green at low opacity in both appearances.

## Data contract changes

All additive, within content-state schema 1, following the pattern of commit
981c49f (optional keys that older payloads omit). Document them in
`docs/battery-hold-live-activity-delivery.md`.

`BatteryHoldMonitoring` (server, stored in the `BatteryHold.monitoring` JSONB
column, so no migration is needed) gains:

| Key | Type | Meaning |
| --- | --- | --- |
| `battery_percent` | number \| null | `live_status.percentage_charged` from this check (or from hold start) |
| `live_at` | ISO string \| null | `live_status.timestamp` (when Tesla measured it) |

`home_load_w` / `sampled_at` keep their names. When a live status is present,
they carry `load_power` and `live_at`; otherwise they carry the latest history
sample, as now.

APNs content state (`LiveActivityContentState` in `battery-hold-apns.ts`) and
Swift `ContentState` gain `batteryPercent: Double?`. The Swift decoder must
treat it as optional, as with the other schema-1 additions. The iOS
`BatteryHoldMonitoring` model gains the matching optional field, so the app's
`ContentState(hold:)` fills it.

The Swift contract test (`battery-hold-activity-contract-tests.swift`) and the
server's APNs payload tests need cases with and without the new key.

## Server changes

1. `parkBattery` (`battery-hold-service.ts`). After `createHold`, record an
   initial monitoring snapshot from the `live` it already fetched, and return
   the hold including it: phase as above, `checked_at` = now, `next_check_at` = the next 15-minute boundary
   (same rule as `summarizeHoldMonitoring`), `battery_percent`, `home_load_w` =
   `load_power`, `baseline_load_w` = `load_power`, `sampled_at`/`live_at` = the
   live timestamp. A failed write must not fail the hold. Log it and move on,
   as `processHold`'s `record` does.
2. `processHold` (`battery-hold-monitor-service.ts`). For active holds of
   *both* modes (timer holds currently skip all Tesla work), call
   `refreshLiveStatus(siteId, …)` with a bounded timeout and the short
   `cacheTtlMs` above, concurrently with
   `refreshTodayData` for Auto holds. It must fit inside
   `MONITOR_SITE_BUDGET_MS` (10s) and the 60-second Vercel Hobby function cap.
   A live-status failure never fails the check. The snapshot just lacks those
   fields, and the phase logic is unaffected. Respect `refreshLiveStatus`'s
   cross-instance claim, so a dashboard refresh moments earlier is reused
   rather than re-fetched. The monitor timing guard test
   (`battery-hold-monitor-timing.test.ts`) must include the new call.
3. `summarizeHoldMonitoring` accepts the optional live status and fills the new
   fields as described under "Calls I made".
4. `battery-hold-apns.ts` maps `battery_percent` → `batteryPercent`.

## iOS changes

1. **Glyph asset.** Add `pwusage-glyph` to the widget extension's asset catalog
   from `assets/pwusage-glyph.svg`, with vector data preserved and rendered as
   a template. The app target may need it too if previews or the sheet use it.
   Live Activities render through the widget extension, so Control Center's
   artwork caching doesn't apply here. Still verify on a device: the Simulator
   gallery has proven unreliable for widget artwork.
2. **A drawn battery view** (new, in `Shared/` or the widget target), built
   from SwiftUI shapes, not images. Parameters: charge (0…100, optional), hold
   level (optional), size style (full card, expanded bar, mini), and
   appearance flags (stale, final). The full and expanded styles use a dashed
   hold line; the mini style uses a solid tick that pokes out of the outline.
   Keep geometry logic testable, e.g. a pure function for fill width and line
   x, in the style of `today-energy-widget-layout.swift`.
3. **`BatteryHoldLockScreenView`.** Put the drawn battery behind the existing
   details. Apply the accent color to the glyph, site name and headline.
   `activityBackgroundTint` stays the system background.
4. **`BatteryHoldActivityPresentation`.**
   - `symbolName` gives way to the glyph asset for the activity (keep
     `BatteryHoldControlIdentity.symbolName` for Control Center).
   - `detail` gains the "Battery N% · " prefix when the charge is known.
   - `deadline` hides the Auto safety stop until the last hour.
   - The phase-`nil` and `waiting_for_data` copy reads naturally once figures
     are present.
   - Existing tests in `battery-hold-activity-presentation-tests.swift` change
     with it. Notably, the test asserting the activity reuses the control's
     symbol name is replaced.
5. **Dynamic Island** as described under "Decisions the user made". The expanded
   leading region holds the glyph and headline; the bottom region holds the bar
   and the text.
6. **Previews.** Update the `#Preview` content states to cover: charge above the
   hold, at the hold, unknown charge, stale, timer, and restored.

## Constraints

- The Vercel Hobby plan caps functions at 60s. The monitor already budgets
  10s per site, 4s for history, and 40s overall.
- Live Activity content state payloads must stay well under Apple's 4KB limit.
  Two numbers are negligible.
- iOS 17+ ActivityKit APIs, as used today. No new entitlements.
- Prefer TDD: failing test first (project convention).
- `npm run build`, `npm run lint` and `npm test` must pass, along with the iOS
  test suite (`cmd/ios-app/run-tests.sh`).

## Left to the builder

- Exact point sizes, opacities, corner radii and dash pattern, within the
  mockups' feel: the fill around 15–20% opacity green, a faint outline and nub,
  the hold line in the accent color. Tune on a device.
- Whether the drawn battery lives in `Shared/` or the widget target.
- The live-status timeout value inside the per-site budget.
- How to express "drawn more faintly" for final states.

## Amendment (2026-10-16, after on-device review): glanceable text

The user found the text too long for a glance: "Checked 10:45 AM" isn't
needed and "Home load is running" is redundant. The text under the headline
is now:

- **Figures line:** `⚡82%` (green bolt, matching the fill), `⌂ 1.8 kW` (current
  home load) and `peak 7.2 kW`. The peak shows only when it reads higher than the
  current load. kW always has one decimal. "started" and the reading's time are
  dropped. The overdue state covers how old the reading is.
- **Status line, only when needed, one line:** a warning (orange triangle) wins
  over a transition, which wins over a deadline. Warnings: "Update overdue",
  "Usage data delayed", "Last check failed". Transitions: "Confirming with
  Tesla", "Load dropped, confirming", "Waiting for first check". Deadlines:
  "Stops 3:21 PM" (timer, plus "· display ends …" past iOS's eight-hour limit),
  "Safety stop 3:21 PM" (Auto, last hour only). Final states give a short reason
  ("Load finished", "Stopped in pwusage", "8-hour safety limit", "Stop time
  reached", "Reserve set to 45% outside pwusage").
- The phase sentences ("Watching home load.", "Home load is running.") and
  "Checked …" are gone. The figures carry the phase.

The same summary sits under the bar in the expanded Dynamic Island. The views
moved to `Shared/battery-hold-activity-views.swift` so the app's tests can
render them (`BatteryHoldActivityRenderTests`).
