# iOS Demo Mode — Design

Date: 2026-11-01
Status: design reviewed; awaiting owner approval

## Why

PWUsage is useless without a Tesla sign-in on a Powerwall site. Apple's
TestFlight and App Store reviewers have no Tesla account, so they stall at the
sign-in screen, and an app reviewers can't get into is a classic Guideline 2.1
rejection. Build 4 is in Beta App Review right now with no way in.

Demo mode gives anyone who isn't signed in a believable, read-only tour of the
app on a sample home. Reviewers come first; curious people who haven't
connected Tesla yet benefit too.

**Success:** a reviewer taps one button on the sign-in screen and sees Home,
Bill and Smart Shift showing the app's value (a bill with about 10 days left in
its cycle, and a clear saving from waiting to charge a car), always knows
they're in a demo, and can leave it.

## Goals

- A **Try the demo** affordance on the sign-in screen, and only there.
  Signed-in users never see it.
- A static, anonymized sample home modeled on the owner's "Harrison" site
  (see Demo data).
- A persistent **In Demo Mode** bar while in demo.
- Clear ways out: the bar's sheet, and **Exit Demo** in Settings.
- A simulated, in-memory battery hold.
- Ships in Release builds (the existing demo data is DEBUG-only today).

## Non-goals (v1)

- Lock Screen / Dynamic Island Live Activity for the simulated hold (demo v2).
- A selectable "Demo" site for the Control Center control (demo v2, with the
  Live Activity).
- Animated or "live" data. The demo is a still snapshot.
- Editing anything. (There is no rate plan editor in the app anyway.)

## Anti-goals (failure even if it "works")

- Any network call to the PWUsage server, Tesla, or Apple push from demo mode.
- Demo state leaking into real state: the Control Center site store, the
  dashboard cache, standard `UserDefaults`, iCloud (CloudKit solar-layout sync),
  saved Smart Shift jobs, or anything that survives a relaunch.
- Real identifying data from Harrison shipped in the app: name, address,
  location/coordinates, site or user IDs, utility account details.
- A user unsure whether they're looking at their own home.
- Getting stuck in demo mode.

## Behavior

### Entering

The sign-in screen (`PWUsage/Views/Auth/sign-in-view.swift`) gets a secondary
**Try the demo** button below the Tesla sign-in button. Tapping it puts the app
into demo mode and lands on the Home tab with the sample home selected. It does
not appear anywhere once signed in.

### What the demo shows

A still snapshot whose timestamps are anchored relative to "now" at launch
(the screenshot run already does this with a `launchedAt` two minutes in the
past), but whose *scenario* always reads as **a weekday afternoon in the peak
period**, regardless of the real day or time. (Today's real Harrison data falls
on a Sunday, which is all off-peak and would show no Smart Shift saving; that's
why the demo is modeled on Harrison rather than a literal copy.)

- **Home:** plausible live power (solar producing, battery partly charged,
  some grid import/export), today's totals, the active tariff showing the peak
  period, and the current bill estimate card.
- **Bill:** a cycle with about **10 days left**, an amount so far, a forecast
  to cycle end, and totals by rate period.
- **Smart Shift:** a car-charge job where **waiting until off-peak (8 PM) is
  clearly cheaper** than charging now, with "How this is worked out" populated
  (rate rows, banked/owed balances, solar contribution, freshness lines).
- **Settings:** Rate Plans, Solar Forecast and About show demo content
  read-only. Solar Forecast uses the demo forecast and must not prompt for
  location permission.

### Demo data

Modeled on Harrison (site `2252268092126997`, billing cycle starts on the 11th,
America/Chicago), anonymized:

- Name: an invented home (the screenshot run uses "Cedar House" with utility
  "Hill Country Electric"; reuse unless a better name falls out).
- Rates (Harrison's winter season): **On-peak $0.31/kWh buy, $0.04 sell,
  weekdays 08:00–20:00; Off-peak $0.10 buy, $0.03 sell** at all other times and
  all weekend.
- Bill cycle: start/end chosen relative to "now" so ~10 days remain.
- Usage and solar shaped like Harrison's (household pattern, solar curve) but
  not copied verbatim from its records; no coordinates.

The screenshot run and the demo should share one fixture source so App Store
screenshots match what reviewers see.

### The demo bar

A full-width bar **below the tab bar**, filled with the app's accent color,
with **"In Demo Mode"** centered in white. It is visible on every tab for the
whole demo session. Tapping it opens a sheet:

> You're looking at a sample home, not your own.
>
> [Sign in with Tesla]   [Keep exploring]

**Sign in with Tesla** leaves demo mode and starts the normal Tesla sign-in.
**Keep exploring** dismisses the sheet.

### Exiting

- The sheet's **Sign in with Tesla**.
- Settings replaces **Sign Out** with **Exit Demo**, returning to the sign-in
  screen (no confirmation needed; nothing is lost).
- **Relaunch always returns to the sign-in screen.** Demo mode is never
  persisted.

### Read-only and the simulated battery hold

Nothing in the demo can change real data. Battery hold is the one interactive
action, simulated in memory: starting a hold shows the normal in-app hold card
and countdown; stopping it ends it. The hold goes through a demo implementation
of the hold API (`fetchBatteryHold` / `sendBatteryHoldCommand`); Live Activity
registration (`registerBatteryHoldActivity` / `unregisterBatteryHoldActivity`)
is a no-op and no Live Activity starts.

### Control Center and Siri

- The demo never writes its sample home to `BatteryHoldControlSiteStore`
  (`Shared/BatteryHold/battery-hold-control-site.swift`), so it never appears
  in the control's site picker.
- If a Control Center control or App Intent opens the app while it's in demo
  mode, the app stays in the demo and presents the In Demo Mode sheet instead
  of navigating to the real site.

## Constraints

- Release-safe: demo code and fixtures compile into Release. Today
  `ScreenshotLaunch`, `DashboardPreviewAPI`, `PreviewPlanningAPI` and
  `PreviewForecastStore` are all `#if DEBUG`; the parts the demo needs must move
  out of DEBUG (the `-PWUsageScreenshotMode` launch argument itself can stay
  DEBUG-only).
- Isolation pattern already proven by the screenshot run
  (`PWUsage/App/screenshot-launch.swift`): its own `UserDefaults` suite cleared
  on start, a temporary folder for the dashboard cache and solar stores, and a
  `SolarLayoutCloudSync` with no transport.
- iOS CI lint: `swiftformat --lint` and `swiftlint --strict` clean, zero
  compiler warnings.
- Keep the demo bar from covering content or the iPad sidebar layout
  (`PWUsage/Navigation/app-tab-view.swift` uses an adaptable `TabView`).

## Decided by the owner

- Entry only on the sign-in screen; signed-in users never see demo mode.
- Static snapshot, not animated; bill ~10 days from cycle end; a clear "wait to
  charge" saving.
- Modeled on Harrison, anonymized.
- Bar below the tab bar, colored, white centered "In Demo Mode".
- Exit via tappable bar sheet and Settings "Exit Demo"; never survives relaunch.
- No changes possible; battery hold simulated in-app; Live Activity and a demo
  Control Center site are v2.

## Claude's calls (owner can override)

- Scenario always reads as a weekday peak afternoon.
- Bar color = app accent color.
- Sheet copy and button labels as above.
- Exit Demo has no confirmation.
- Demo and screenshot run share one fixture source.
- Control-opened-in-demo shows the sheet rather than ending the demo.

## Settled after builder review (Claude's calls)

- **Scenario clock.** No injected clock is needed: Smart Shift and Bill read
  absolute-timestamp data from the server (`tariffTimeline`, `cycleStart`/
  `cycleEnd`, `isActive` periods, precomputed phrases), so demo fixtures built
  relative to the real "now" make On-peak active now, Off-peak start a few hours
  later, and the cycle end 10 days out, at any real day or hour. Clock times
  shown on screen follow the real clock (off-peak may read "starts at 2:15 AM"
  rather than literally 8 PM); that's acceptable.
- **Screenshots adopt the demo scenario.** One shared demo factory with two
  callers: the Release sign-in button and the DEBUG `-PWUsageScreenshotMode`
  launch argument. App Store screenshots change to match.
- **Bar placement.** A bottom inset spanning the window on every layout:
  below the tab bar on iPhone, at the bottom of the window on iPad (sidebar or
  top tab bar). It must not overlap the tab bar or content.
- **Solar Forecast in demo** shows the demo forecast (as the screenshot run's
  `PreviewForecastStore` does); solar history may stay disabled.
- **Every external route** into the app while in demo (Control Center, App
  Intents, deep links/`onOpenURL`, `/continue` QR flow, notification taps)
  shows the In Demo Mode sheet; none navigates to real data.
- **Real state untouched.** Entering demo from a signed-out or re-auth sign-in
  screen leaves the real dashboard cache, defaults and account scope intact;
  exiting returns to exactly the sign-in state that was there before.
- **Simulated hold** offers the same choices as the real one, counts down,
  survives tab switches and sheet dismissal within the session, can be stopped,
  and expires on its own back to idle.

## Left to the builder

- How demo mode is represented in `PWUsageAppModel` / root view state, and how
  the demo `PWUsageApplicationAPI` and hold API are injected.
- Exact fixture numbers, within the scenario above.
- Bar height, safe-area handling, and iPad placement.
- Test strategy (unit tests for "no persistence / no network", UI test for
  enter → tabs → exit).

## After it ships

Update TestFlight Beta App Review notes to tell reviewers: "Tap **Try the demo**
on the sign-in screen."
