# pwusage for iOS

This directory contains the SwiftUI app source and the XcodeGen specification. The generated `PWUsage.xcodeproj` and target `Info.plist` files are local build inputs and are ignored by git.

## Generate and build

Install XcodeGen 2.46 and Xcode 27, then run:

```sh
./generate.sh
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Run the native tests with `./run-tests.sh`. Tests use Swift Testing (`import Testing`). It selects an available iPhone simulator and stops the run after 10 minutes if Xcode hangs. Run all tests with `./run-tests.sh`, or target specific suites/tests (e.g. `./run-tests.sh AppConfigurationTests` or `./run-tests.sh AppConfigurationTests/defaultsToProductionAPIOrigin`). Use `PWUSAGE_SIMULATOR_ID=<simulator-udid> ./run-tests.sh` to choose a device or `PWUSAGE_TEST_TIMEOUT_SECONDS=<seconds> ./run-tests.sh` to adjust the deadline. Failed runs retain the result bundle and build files at the printed path.

The app targets iOS 18 and uses `fm.rodeo.pwusage` as its bundle identifier. The project intentionally configures `DEVELOPMENT_TEAM: 6HQGHHRK87` in `project.yml` for device deployment. Preserve this setting unless the user explicitly asks to change or remove it. Regenerate the project with `./generate.sh`, select your connected device in Xcode, and run. Simulator CI disables signing with `CODE_SIGNING_ALLOWED=NO`.

To build for a device from the command line:

```sh
xcodebuild -project PWUsage.xcodeproj -scheme PWUsage -destination 'generic/platform=iOS' build
```

## TestFlight releases

Fastlane follows SleepDaddy's shared `match` signing setup. Run commands below from `cmd/ios-app` with Ruby 3.3 and Bundler:

```sh
bundle install
bundle check
bundle exec fastlane lanes
```

### One-time Apple setup

1. Register the explicit App ID `fm.rodeo.pwusage` under team `6HQGHHRK87` in Apple Developer. No HealthKit capability is needed.
2. The iOS app is registered as [pwusage, Apple ID 6818639504](https://appstoreconnect.apple.com/apps/6818639504/) with bundle ID `fm.rodeo.pwusage`. Ensure the release API key has access to this app and Certificates, Identifiers & Profiles.
3. Provide `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_CONTENT` (base64-encoded `.p8`), `MATCH_GIT_URL`, and `MATCH_PASSWORD`. Git authentication uses either `MATCH_GIT_BASIC_AUTHORIZATION` (base64-encoded Git credentials, for HTTPS) or `MATCH_GIT_PRIVATE_KEY` (SSH key path/content, for an SSH URL), never both. Keep credentials in a private environment or ignored `fastlane/.env` file. Do not commit credentials. The team ID is intentionally checked in; no team secret is required. Televista's existing credentials were verified for this app; SleepDaddy's local API-key copy was not valid.
4. From an authorized local machine, run `bundle exec fastlane ios prepare_signing` once to add pwusage's App Store profile to the shared signing repository. This lane can create signing assets; the release lane uses `match` in readonly mode.
5. CI is configured with `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_CONTENT`, `MATCH_PASSWORD`, `MATCH_GIT_URL=git@github.com:KevM/20four7-certs.git`, and `MATCH_GIT_PRIVATE_KEY`. The deploy key on `KevM/20four7-certs` is read-only and dedicated to pwusage. Signing assets live on its `master` branch. Local signing preparation needs write access; the CI deploy key cannot create or update profiles.
6. Deploy the website's public pages and use `https://pwusage.fm.rodeo/privacy` for the App Store privacy-policy URL and `https://pwusage.fm.rodeo/support` for its support URL. The policy describes server account/energy data and optional device-local Solcast credentials; review it when data handling changes.

Privacy and support links are also available on the native sign-in screen and the About sheet, opened from the dashboard’s More menu.

### Upload a build

Run the **iOS Release to TestFlight** GitHub workflow manually, or tag the checked-in marketing version using the iOS-specific tag namespace:

```sh
git tag ios-v1.0.0
git push origin ios-v1.0.0
```

The tag must match `MARKETING_VERSION` in `project.yml`. The workflow runs native tests before archiving and retains the IPA, debug symbols and build logs for 14 days. Local uploads use `./run-tests.sh` followed by `bundle exec fastlane ios beta`. To verify signing/export without an upload, use `bundle exec fastlane ios archive`; the IPA is written to `build/PWUsage.ipa`.

The lane queries TestFlight for the latest build of the marketing version and uses the larger of the checked-in build number or that number plus one. It applies this only to the archive, keeping `project.yml` as the version source. Avoid simultaneous local and CI releases; the workflow serializes its own uploads. After archive/export, it regenerates the development project to restore automatic signing.

Uploads use the **Release production API**, `https://pwusage.fm.rodeo`, and skip beta submission and processing waits. Assign processed builds to internal testers in App Store Connect. External testing requires Apple's beta review and completed test information. Uploading does not publish to the App Store or automatically distribute to external groups. See the [Fastlane TestFlight guide](https://docs.fastlane.tools/getting-started/ios/beta-deployment/).

### Release checks

- Verify a signed archive/export and App Store upload with valid release credentials. An unsigned local archive proves compilation and bundle configuration, not distribution signing.
- Verify the 1024-pixel app icon has no alpha channel. The current icon is flattened onto white and stored as RGB PNG. The app includes `PrivacyInfo.xcprivacy` for its app-private UserDefaults usage, using Apple's approved `CA92.1` reason, and declares account email, user identifiers and other service data used for app functionality.
- Confirm production contains the mobile sign-in migration and routes described below. On a real device, verify sign-in, session renewal, sign-out, dashboard, and the optional forecast flow. Check Battery Hold only with an intentional, confirmed device command.
- Complete App Store Connect's app privacy answers for the service's actual data collection, review the public privacy policy, and supply beta review contact details and a usable review account or review instructions.
- Before a public App Store submission, assess and implement Apple's in-app account-deletion requirement for the Tesla-linked service account. The support page's deletion-request instructions do not replace an in-app deletion flow.

## API origin

Both Debug and Release builds use `https://pwusage.fm.rodeo` for sign-in and dashboard data by default. `AppConfiguration` accepts an injected origin for tests and local development; Release requires HTTPS and allowlisted hosts. To override a Debug build for a local server or beta, set `PWUSAGE_API_ORIGIN` (e.g. `http://localhost:5174` or `https://pwusagebeta.fm.rodeo`) in the Xcode build environment or scheme. Do not commit credentials.

When checking a server-side problem by hand, match the host to what the build is pointed to. Note that a `401` means the route exists but rejected the unauthenticated request, while a `404` means the route is not deployed at that host. The two are easy to conflate when only one host is checked.

## Server routes the app depends on

Some features are only half-present in the app binary; the other half is a web route that must be deployed. Verify a route exists before blaming the device, the data, or the provider:

```sh
npx tsx scripts/check-mobile-routes-on-base.ts [baseRef]   # from the repository root
```

This exits non-zero when a route the app calls is absent from the base ref. A 404 from `/api/mobile/load-planning-context` means the deployment predates that route, and the app reports it as an out-of-date server rather than as missing household data.

The Solcast enhancement is split this way: the Solcast forecast itself is device-local and works without any server route, but the household profile it is compared against comes from `/api/mobile/load-planning-context`. If that route is missing, the forecast half succeeds while the app still shows no recommendation, because there is no baseline to compare it to.

## First-release behavior

- The native dashboard shows live solar, home, battery, and grid power; today’s energy totals; the active tariff; and the current bill estimate.
- The bill screen uses the dashboard’s shared response. Opening it does not trigger another request.
- The app restores a prior `site_auth` cookie by requesting `/api/sites` once at launch. It opens the secure pwusage sign-in flow only when that cookie is rejected or missing. Selected site is remembered on this device.
- On subsequent launches, the dashboard immediately restores the last successful site, live, and bill responses from a small Codable snapshot in the iOS caches directory, then validates the session and refreshes. Saved data remains visible offline with its original timestamps and a saved-data notice. Pull to refresh retries site validation after an offline launch. Snapshots are separated by API origin and site, pruned when site access changes, and cleared on sign-out or session expiry. iOS may evict this disposable cache.
- One app-owned coordinator requests live data at most every five minutes and the bill on three tiers: at most every 30 minutes on the foreground timer, at most every five minutes when the Load timing screen opens, and always on an explicit pull to refresh. It stops timers in the background, and before the coordinator is dropped on sign-out, and makes a due bill request after the live request, so a stale-history refresh is reflected in the bill.
- When the stored energy sample is over 30 minutes old, the mobile live endpoint asks the server to refresh it before responding. A per-site import lock limits these attempts to once every 30 minutes, and only a successful import rereads the energy buckets. Normal polls add no database read.
- A recent last-known battery charge may be shown with its source age; values older than two hours remain unknown (`--`). Source timestamps stay attached to readings. Missing energy data, expired sessions, and temporary server/network failures have separate states.
- The Load Timing toolbar includes native battery hold controls. Automatic holds restore when charging ends, with an eight-hour safety limit; fixed holds run for 1–24 hours. Starting a hold and restoring the original reserve require explicit confirmation. Stop the Battery Hold resets the original reserve, including changes made in Tesla. Automatic restoration uses the server's reserve-change safeguard and shows a dismissible cancellation notice when that safeguard cancels a hold. There is no background refresh or notification support for Battery Hold.

SwiftUI previews under `PWUsage/Views/DashboardPreviews.swift` use fixed, local sample payloads for normal readings, no energy samples, stale source timestamps, an unavailable server, sign-in, and bill detail. The previews do not contact pwusage or a database.

The previews compiled as part of the simulator build, but they were not visually inspected in this run because the Mac UI session was locked.

Native sign-in requires the server’s mobile handoff migration to be deployed. The Solcast enhancement additionally requires `/api/mobile/load-planning-context` to be deployed; see [Server routes the app depends on](#server-routes-the-app-depends-on). Production deployment and real-device cookie renewal/logout checks remain release gates; they are intentionally outside this implementation task.

## Diagnosing an unavailable forecast

The Load timing screen shows one small note when the optional forecast cannot be used, and the note names the actual blocker rather than blaming the forecast in general. A "could not reach your server" note points at sign-in or connectivity; an "app build is newer than the server" note points at a deployment gap; notes naming household history describe the server’s 14-day window, which is a server-side data question rather than a device or Solcast one.

To investigate a household-data problem, query the real database rather than trusting a note:

```sh
cd cmd/next-app && npx tsx scripts/load-planning-context-capture.ts <siteId>
```

This runs the same query and the same profile builder as the route and prints the diagnostics the route hides: row counts, per-day coverage against the 90 percent gate, off-grid timestamps, and non-finite values. It prints no site name, no credentials, and no per-interval values, so it is safe against production data.

## Tariff sheet

The tariff sheet reads saved seasons, periods, rates, and current activity with `GET /api/site/[id]/refresh-tariffs`. This shares the web app’s existing tariff endpoint; `POST` explicitly refreshes rates from Tesla. GET does not call Tesla. The server must include GET support before testing this app build on a device.

## Battery hold sheet

The battery button beside the Load Timing gear opens a native sheet using the
existing `GET` and `POST /api/site/[id]/battery-hold` endpoint and authenticated
cookie transport. Hold status refreshes once per minute while Load Timing or the
sheet is visible, and on foregrounding. GET reads saved state and does not call
Tesla. Only explicit hold/stop commands invoke Tesla controls. The toolbar uses
an unaccented battery glyph while idle, and an accented battery with the
confirmed hold reserve while active (not live battery charge). The accessibility label identifies the
Battery Hold controls and their state; failed or stale refreshes disable controls
until status is confirmed again. An active hold can be restored even when charge
or tariff data is unavailable. Reconnecting uses the app's existing Tesla login
flow to grant Energy Product Commands permission.

Local-only previews in `PWUsage/Views/battery-hold-previews.swift` cover idle,
reserve choice, active timer, monitored automatic and cancelled holds. The preview tests render the
native sheet at standard and accessibility text sizes without contacting Tesla.
Live Tesla commands still require a device check against a deployed server.

Automatic holds show the last cron evaluation, estimated power above starting
home usage, usage reading time, and a countdown to the next quarter-hour check.
Overdue checks and stale readings are shown explicitly. Monitoring is optional
for compatibility with older servers. Deploy the battery_hold_monitoring
migration and updated restore-reserve route before checking this status on beta;
an existing hold receives monitoring after its next scheduled check.

The permanent refresh button has been removed. Missing charge data is refreshed
on sheet entry before starting a hold. Try Again appears when charge or hold
status needs recovery; pull-to-refresh remains available. Stopping a hold does
not require charge data and explicitly confirms resetting the original reserve.

Starting a hold validates Tesla's current backup reserve before sending any
command. During the first minute after stopping a prior hold, a reading
that still matches that prior hold's target is treated as pending synchronization
and starting is refused with a recovery message. This prevents a cached hold
target from becoming the next original reserve. This guard does not guarantee
upstream cache freshness once that window expires.


## Today's Energy widget

The embedded `PWUsageWidgets` extension supports medium and large Today’s Energy widgets and a configurable small Today’s Metric widget.
It mirrors the app's **Today so far** section: Home, Solar, net Grid and net Battery
energy, using the same shared metric tiles, tinted backgrounds, glyphs, numeric
formatting and import/export/charge/discharge labels. The battery glyph's fill conveys
state of charge using the app's charge bands, with the percentage immediately to its left.
Unknown or expired SOC has no percentage; VoiceOver announces valid percentages or unknown charge.
Unknown charge uses the empty outline and an explicit unknown accessibility label.
Medium widgets use a short “Today” headline with the update time inline and center the labels and values in equal-height tiles. They keep direction arrows and omit repeated net-direction captions; VoiceOver still reads the full details. Medium text growth is capped at X Large to fit its fixed height, while large widgets retain the full text-size range. Large widgets omit repeated direction captions and the active-tariff footer to keep the energy and cost glanceable. Their footer shows the update time and a compact partial-data warning when needed. Full direction descriptions remain available to VoiceOver. Both sizes show
the site and last energy update time. Tap the widget to open pwusage.

The widget uses `MobileLiveResponse.today`, optional `todayCost`, and source timestamps.
The Large widget adds **Today's Cost**: prominent estimated net cost with smaller import
charges and export credits in the site's currency. These are daily tariff/TOU netted
charges and credits from the existing `getUsageByTOU` calculation, not gross energy
flows or billing-cycle totals. Missing pricing shows “Cost unavailable”; older server
responses and snapshots remain readable. Small and Medium layouts are unchanged.

Deploy the additive `todayCost` field in `/api/site-live-data?view=mobile` to populate
real costs. Mobile and widget refreshes use the existing authenticated mobile endpoint,
including its server-side Tesla refresh throttling. Today energy is **net** for
Grid/Battery, with the app's arrows and sign conventions.

The app publishes the selected site's presentation totals, daily cost and timestamped
SOC to an atomic, versioned JSON file in its App Group, protected until first unlock.
Both widget timeline providers independently fetch `/api/site-live-data?view=mobile`
for that selected site. The app and extension use Foundation's persistent App Group
cookie store for `site_auth`; existing app-private sessions migrate once on launch.
No Tesla tokens, Solcast keys or battery commands are shared. Debug and Release use
separate groups and matching API origins.

The extension keeps its last successful response in a separate protected cache tied
to the exact app-published selection and API origin. Nearby timeline requests reuse
that response for up to five minutes. Network/server failures preserve the reading
and its original source timestamps; rejected authentication/access hides it. Logout,
session expiry, revoked sites and site changes clear or replace the app's selection
and request a WidgetKit reload. Results from an invalidated selection are discarded,
and the extension never rewrites the selection. WidgetKit can retain a previously
rendered view until it honors the reload.

The app also publishes after successful foreground refreshes. WidgetKit is asked to
fetch again after 30 minutes, with scheduled entries for energy staleness, SOC expiry
and site-local midnight. Energy older than 30 minutes is labeled stale. SOC expires
independently after two hours. Prior-day, future-dated, corrupt, unsupported or missing
snapshots show unavailable. Snapshot version 2 is retained. WidgetKit refresh dates
are requests, not guaranteed deadlines; the source time makes delayed updates visible.
See [Apple's refresh guidance](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date).

### Apple and Xcode setup

1. Register the extension App ID `fm.rodeo.pwusage.widgets` under team `6HQGHHRK87`.
2. Register `group.fm.rodeo.pwusage` and `group.fm.rodeo.pwusage.debug` in Apple Developer,
   and enable both App Groups for **both** the app and extension App IDs. The build
   configuration selects the production or debug group through `PWUSAGE_APP_GROUP`.
3. Run `./generate.sh`. XcodeGen configures the extension dependency/embedding,
   entitlements, WidgetKit extension point and the shared sources. Both targets retain
   automatic development signing and the committed team ID. Allow Xcode to refresh
   development profiles after enabling capabilities.
4. Run `bundle exec fastlane ios prepare_signing` on an authorized machine after the
   capability changes. Match now includes both bundle IDs; regenerate the app profile
   with App Groups and create the extension profile. The archive/export lane supplies
   separate manual signing profiles for both targets. CI's read-only signing repository
   must contain those refreshed profiles before another TestFlight release.
5. On a device, launch and sign in, refresh the dashboard, then add Today's Energy from
   the widget gallery. Check both sizes, site switching, locked-device behavior after
   first unlock, sign-out, offline aging and site-local midnight. Simulator compilation
   does not verify Apple provisioning or WidgetKit's real refresh budget.

The shared `TodayEnergy` presentation model/store lives outside app UI and networking.
Future Battery Hold Live Activities can add their own state contract and lifecycle without
sharing authentication or command handling with this widget. ActivityKit is not added.


### Widget previews in Xcode

For medium/large widgets, open `PWUsageWidgets/today-energy-widget-previews.swift`.
For small widgets, open `PWUsageWidgets/today-energy-metric-widget-previews.swift`.
Show the Xcode Canvas using a Debug configuration and an iPhone simulator destination.
The small file starts with an **All four small choices · Layout** board and an individual
battery layout preview, which render the actual content without WidgetKit/App Intents
preview hosting. Its **Small · Home/Solar/Grid/Battery** previews use `.systemSmall`
and the configurable `TodayEnergyMetricWidget`. The `TodayEnergyWidget` gallery entry intentionally supports medium and large only.
If Canvas overrides its family to Small, the shared family router now renders the Home
single-metric layout instead of squeezing the large four-metric view into a small frame.
Use `TodayEnergyMetricWidget` previews for the configurable small selections.
Run `./generate.sh` and reopen the generated project if the new file is not in Xcode. Named previews cover both
sizes, import/discharge and export/charge, full/low/unknown/stale SOC, stale energy,
missing intervals/data, long names/large totals and a fresh-to-stale-to-next-day timeline.
Fixtures use a fixed clock and local data; no sign-in, App Group setup or server access
is required. The native widget tests also render the actual shared widget content in
both sizes and light/dark appearances for visual inspection.


### Configurable small widget

Add **Today's Metric** in the widget gallery for the small size. Home is the default.
Long-press it, choose **Edit Widget**, and select **Metric → Home, Solar, Grid, or Battery**.
Each small widget has its own selection, so you can add several with different metrics.
Grid and Battery retain the same net-energy arrows as the app; Battery uses the SOC glyph.
Small widgets use the same refresh path, protected cache, selected site, staleness/SOC
expiry and midnight schedule as the larger widgets.

This is a separate App Intents configuration and widget kind in the existing extension.
Existing medium/large widget kinds and configuration remain intact; no new signing,
App Group or server setup is required. Both kinds reload when the app saves or clears
its snapshot. Xcode previews include all four small selections plus stale, unknown-SOC
and unavailable states. Check **Edit Widget** selection and multiple independent widgets
on a device; simulator builds verify App Intents metadata and layout, not the full picker UI.

### Battery Saver in Control Center (iOS 18+)

Open pwusage and sign in so the app can load your sites. In Control Center, choose
**Add a Control → pwusage → pwusage Battery Saver**, then select its **Site**. Each control
keeps its own site, independently of the dashboard selection. Tap it to open the
existing Battery Saver sheet and choose a reserve/duration or review an active hold.
Adding or tapping the control does not send a Tesla command.

The launcher is included in both app and extension intent metadata. Its OpenIntent
runs in the foreground app and queues the requested site until the UI is ready.
The app reloads the authorized site list before presenting the sheet. Sign-in and
connection retries retain the request; a removed site or malformed link shows a
message instead of opening another site's controls. Explicit sign-out discards a
pending request. Valid external launches reset the dashboard navigation and its
other sheets before opening Battery Saver; the normal toolbar retains navigation.
The existing sheet refreshes hold status and controls all writes.

The existing App Group carries a separate protected, atomically replaced picker
file containing only site IDs/names. It is refreshed from authorized site loading
and cleared on logout/session invalidation. A saved control may retain an old site
identifier, which is checked again in the app. The control adds no shared cookies,
credentials or App Groups; the Live Activity below is the only APNs/ActivityKit use.

Device acceptance still requires a signed iOS 18 build: verify gallery/configuration,
several controls for different sites, cold and warm taps, tap while signed out then
sign in, offline retry, removed-site behavior and an existing active hold. Check
locked-device launch/unlock and return to the sheet from another app screen. Do not
start/restore a real hold without explicit Tesla command test authorization.
Simulator tests/builds validate routing and intent metadata, not Control Center's
device handoff or signed provisioning.

The Battery Saver control's icon is the system symbol `bolt.batteryblock`
(`BatteryHoldControlIdentity.symbolName`). Its main label is **pwusage**, with the
configured site as the secondary label; the gallery name is **pwusage Battery
Saver** (it was **pwusage Battery Hold**; Control Center may show the old
name until the device restarts). Existing controls keep their kind and site configuration.

**Don't swap in a custom symbol without a device test, and restart the device
between tests.** Control Center caches the last artwork it drew for a control
kind; deleting and reinstalling the app does not clear it, but a restart does. A
blank result without a restart is not evidence.

A branded Powerwall glyph was tried. The hand-written template SVG rendered blank
on device even after a restart. A genuine SF Symbols app export (Template v7), and
a `hierarchical` rendering intent, were also reported blank, but a restart before
those checks was not confirmed, so they are inconclusive. Every variant compiled
into the extension and drew in-process, so native pixel tests cannot catch this.
`bolt.batteryblock` in the identical inline `Label` renders correctly. The iOS
Simulator's gallery also blanks Apple's own Ambient Music controls, so it is no
substitute for a device check.

Control Center draws the resting tile from the button's **label**
(`Label("pwusage", systemImage:)`, inline in
`ControlWidgetButton(action:label:actionLabel:)`); the action label is only the
transient state while the action runs and carries the site name.

Opening the app asks the system to reload configured Battery Saver controls, but
that does not refresh cached artwork. After an icon change: remove the control,
install, restart the device, then re-add the control.

### Battery Hold Live Activity

After you confirm a hold in the app, pwusage starts a Live Activity (token pushes
only, no push-to-start) and registers its push token with
`/api/site/{id}/battery-hold/activities`. The server then sends `update` and `end`
pushes (content-state schema 1, `docs/battery-hold-live-activity-delivery.md`).
A hold started on the web or another phone is not shown automatically: the Battery
Hold sheet offers **Show on Lock Screen**. Taps open that sheet; stopping goes
through its confirmation. Denied or failed Live Activities never affect the hold.

`BatteryHoldActivityCoordinator` owns the lifecycle: it re-registers rotated tokens
(retrying temporary failures), reconciles on foreground and relaunch (database
reads only, never Tesla), unregisters dismissals it observes or finds later,
ends activities for sites the account can no longer access, and on sign-out
unregisters before clearing every activity. It stores a token digest, never the token.

Apple ends a standard Live Activity after eight hours. Fixed holds can run 24 hours,
so the activity and the sheet say when the display ends; the app never restarts it.

Setup: enable **Push Notifications** on the App ID `fm.rodeo.pwusage`, let Xcode refresh
development profiles, and run `bundle exec fastlane ios prepare_signing` so the App
Store profile carries `aps-environment` before the next TestFlight build. The
entitlement and `PWUSAGE_APS_ENVIRONMENT` come from one build setting: `development`
(APNs sandbox) for Debug, `production` for Release. Each registration reports that
value; the server accepts production only on the production deployment.

Device checks (need the delivery cron from plan Task 5 merged, the APNs key in
Vercel, and signed builds; don't send real Tesla commands without an explicit test
scope): updates arrive with the app closed; token rotation re-registers; sign-out
clears the Lock Screen and stops pushes; two phones on one hold; restore and cancel
end it with the right final text; dismissal stops pushes; the eight-hour end of a
long fixed hold; overdue text once updates stop; Dynamic Island layouts; taps open
the sheet when locked, signed out, and cold. Repeat on a Release/TestFlight build for
production APNs. Simulator tests cover the contract and lifecycle with a fake
ActivityKit, not system rendering or delivery.
