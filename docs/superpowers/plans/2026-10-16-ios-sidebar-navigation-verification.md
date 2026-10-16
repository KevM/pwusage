# iOS sidebar navigation verification — 2026-10-16

Branch: `feat/ios-sidebar-navigation`. Task 8 implementation: `7b52b60`.

## Automated checks

- RED: `cmd/ios-app/run-tests.sh BatteryHoldCoordinatorTests` failed on all six new exact Battery Saver label assertions before the copy change.
- GREEN: `cmd/ios-app/run-tests.sh` passed **549 tests in 35 suites**, including the new assertions. This builds the app and test targets. The same full run satisfies Tasks 8 and 9 because no implementation changed afterward.
- `npm run lint` in `cmd/next-app` passed.
- `npm run build` failed because Turbopack could not bind a local worker port (`Operation not permitted`), including an elevated retry. The documented fallback `npm run build -- --webpack` passed. No web configuration changed.
- `git diff --check` passed.
- Temporary simulator source and app-entry-point patch were removed; the Xcode project was regenerated before the iOS suite and commit. Signing configuration is unchanged.

## Simulator evidence

The temporary DEBUG fake-data harness from the hand-off was built and installed on iPad Pro 13-inch (M5), iOS 27, `AE91EE3D-5E84-4C2B-895D-981EF8CEF26F`. It has two fixture sites and makes no Tesla requests.

Screenshots are local, git-ignored artifacts under:

`.superpowers/sdd/2026-10-16-ios-sidebar-navigation/screenshots-task9/`

- `ipad-portrait-sidebar.png`: all four sidebar entries with symbols, Cedar House site header, and normal-text Home using two columns behind an overlay sidebar.
- `ipad-accessibility-largest.png`: Home switches to one column at `accessibility-extra-extra-extra-large`. Only the upper Home content is visible; scrolling to every card was not checked. The original simulator content size (`large`) was restored.
- `ipad-warm-deep-link.png`: system “Open in pwusage?” confirmation after `pwusage://battery-hold?site=preview-home`. This does **not** prove successful routing or sheet presentation.

The screenshot build predates Task 8; it does not visually verify the renamed sheet or glyph.

## Remaining manual checks

Task 7 Step 5 and Task 9 Step 2 remain open. The computer-use tool rejected Simulator by display name, app path, and bundle ID (`Invalid app`). Command-line simulator control and screenshots work, but there is no interactive Simulator connection to accept the URL prompt, switch tabs, collapse the sidebar, rotate, resize windows, or scroll.

- Collapsed-sidebar warm deep link: Smart Shift selected, Battery Saver sheet visible, sidebar remains collapsed.
- Smart Shift polling: fetch on appearance, no fetch for more than 60 seconds after switching away, fetch again on return.
- iPad landscape: sidebar and site header shown, all four Home cards visible without scrolling.
- Narrow Split View: Home single column and native top tab bar with sidebar collapsed.
- Normal-text portrait expectation: the plan says one column, but the captured 13-inch portrait window uses two. The binding spec bases layout on available width/size class/accessibility size, and the approved Task 4 threshold is 700 points. No orientation-specific override was added; resolve the desired portrait behavior on device.
- Cold deep link with saved Bill: Smart Shift + sheet for that visit, then Bill on normal relaunch. This continuation did not recheck the prior session's iPhone warm-link/persistence checks.
- iPhone bottom bar, Settings push navigation, Sign Out confirmation, and the new Battery Saver title/glyph need a final interactive check. The hand-off reports the first three passed before Task 8.
- Real Tesla session and physical-device behavior were not verified; the harness uses fixture data.

No push or pull request was made. Unrelated staged ignore files were excluded from commits.

For on-device checks:

```sh
open /Users/kevm/github/pwusage/cmd/ios-app/PWUsage.xcodeproj
```
