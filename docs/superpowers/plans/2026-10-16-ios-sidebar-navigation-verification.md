# iOS sidebar navigation verification — 2026-10-16

Branch: `feat/ios-sidebar-navigation`. All nine tasks are complete. Battery Saver copy: `7b52b60`; duplicate site-header house glyph removed: `9c78e23`.

## Automated checks

- RED for Task 8: `cmd/ios-app/run-tests.sh BatteryHoldCoordinatorTests` failed on all six new exact Battery Saver label assertions before the copy change.
- Full iOS suite after the header cleanup: **549 tests in 35 suites passed**, including app-model tab persistence, deep-link routing, site changes, sign-out reset and width/accessibility layout rules.
- Final post-harness `cmd/ios-app/run-tests.sh`: **549 tests in 35 suites passed**; app and test targets built successfully.
- Fresh `npm run lint` and `npm run build -- --webpack` both passed.
- The default Turbopack build previously failed because its worker could not bind a local port (`Operation not permitted`), including an elevated retry. Webpack is the documented fallback; no web configuration changed.
- Temporary harness source and app-entry-point patch were removed before the final full iOS run. The test script regenerated the Xcode project. Signing configuration is unchanged.

## Simulator checks completed

Device Hub at `/Applications/Xcode.app/Contents/Applications/DeviceHub.app` exposes both simulators for computer use. The earlier blocker applied to the standalone Simulator app, not Device Hub.

Checked the latest app using the temporary DEBUG fixture API from the hand-off. It supplies two sites and makes no Tesla requests. A temporary simulator-only flag retained the fixture API across cold launches; neither the flag-handling code nor the harness is committed.

### iPad Pro 13-inch (M5), iPadOS 27

- Landscape with sidebar shown: four entries and symbols, site header without a duplicate house glyph, all four Home cards fit without scrolling.
- Collapsed-sidebar warm link from a user-selected Bill tab: `pwusage://battery-hold?site=preview-home` opened Battery Saver, selected Smart Shift and kept the sidebar collapsed. Dismissing the sheet exposed the top tab bar with Smart Shift selected.
- Normal relaunch restored Bill after the warm-link visit.
- Cold link with Bill saved: opened Battery Saver on Smart Shift. Normal relaunch again restored Bill.
- Polling lifecycle: fixture fetch at **15:16:34**, switched Home about **15:16:42**, no fetch through **15:17:49**, then fetch at **15:17:52** on return to Smart Shift. Subsequent log entries are the separate deep-link checks. This replaces the planned breakpoint check with observable API fetch logging.
- Largest accessibility size: one-column Home; swiped to the lower Today content, Current Bill and Smart Shift cards. Restored original text size (`large`).
- Narrow half-width portrait window: one-column Home, all four cards visible, native compact bottom tab bar. Used the system Window → Move & Resize → Left command in Stage Manager. Restored the original Windowed Apps setting afterward.
- Full-width portrait: two columns with a native top tab bar when the sidebar is collapsed.

### iPhone 18 Pro, iOS 27

- Four bottom tabs and single-column Home.
- Settings → Rate Plans and About both push with a Settings back button. Fixture API intentionally has no rate-plan response; Rate Plans displayed its unavailable state, so real rate content was not checked.
- Sign Out opens a confirmation; dismissed it without signing out.
- Smart Shift toolbar displays the shield/bolt glyph and opens the sheet titled Battery Saver.

## Screenshot and log artifacts

Local, git-ignored directory:

`.superpowers/sdd/2026-10-16-ios-sidebar-navigation/screenshots-final/`

| File | Evidence |
|---|---|
| `ipad-landscape-home.png` | Sidebar and all four Home cards |
| `ipad-portrait-home.png` | Wide portrait, top tabs, two columns |
| `ipad-accessibility-lower-cards.png` | Largest text, one column, lower cards reachable |
| `ipad-narrow-home.png` | Half-width portrait, one column, compact native tabs |
| `ipad-warm-link-sheet.png` | Battery Saver after warm link |
| `ipad-warm-link-collapsed.png` | Smart Shift selected, sidebar still collapsed |
| `ipad-relaunch-bill.png` | Bill restored after the warm-link visit |
| `ipad-cold-link-sheet.png` | Battery Saver after a cold launch link |
| `iphone-home-tabs.png` | Four bottom tabs, one-column Home |
| `iphone-rate-plans-pushed.png` | Rate Plans navigation and back button |
| `iphone-about-pushed.png` | About navigation and back button |
| `iphone-sign-out-confirmation.png` | Sign Out confirmation |
| `iphone-smart-shift-glyph.png` | Shield/bolt toolbar glyph |
| `iphone-battery-saver-sheet.png` | Updated sheet title |
| `polling.log` | Fetch stop/restart timestamps |

## Plan interpretation and remaining limits

The original plan expected every portrait iPad to use one column and every collapsed iPad tab bar to stay at the top. The binding spec instead requires measured width/size class/accessibility layout and native adaptive tabs. Retained that implementation: a full-width 13-inch portrait window exceeds 700 points and uses two columns; a narrow window uses one column and iOS chooses bottom tabs. No orientation rule or custom tab placement was added. The narrow test uses iPadOS 27 half-window tiling rather than the older Split View UI.

These checks use fixtures. Real Tesla authentication, successful rate-plan loading, physical-device control commands, older iPadOS versions, VoiceOver interaction, and Mac behavior were not verified here. The user separately confirmed the header cleanup looks good on device.

No push or pull request was made. Unrelated staged ignore files remain excluded from commits.

For further on-device checks:

```sh
open /Users/kevm/github/pwusage/cmd/ios-app/PWUsage.xcodeproj
```
