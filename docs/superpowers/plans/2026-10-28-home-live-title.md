# Home Live Scoreboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the iOS Home tab, when the Live power card scrolls up under the navigation bar, the site name in the bar is replaced by a compact "scoreboard" of live stats, the way Apple Sports shows a game's score once you scroll past it. Scrolling back down brings the site name back.

**Architecture:** A pure `DashboardPresentation.liveScoreboard(flow:stateOfCharge:)` builds the stats from the `PowerFlow` the Live card already computes, so the bar and the card always agree on idle and stale rules. `DashboardView` tracks whether the Live card is on screen with `onScrollVisibilityChange` and puts a new `HomeLiveTitle` view in a `.principal` toolbar item. That view shows either the site name or the scoreboard. `navigationTitle(site.name)` stays for the sidebar, the app switcher and VoiceOver.

**Tech Stack:** SwiftUI (iOS 18 deployment target; `onScrollVisibilityChange` is available), Swift Testing, XcodeGen.

**Spec:** The user's requests (2026-10-28): "When I scroll up I'd like to put the live production details into the top bar that currently just has the site name on it." Then: "Like the Sports app … small little representations of the important live data points (battery soc, home usage, solar production). The other two would be nice (grid, battery usage)." The design decisions below act as the spec.

## Design decisions

- **Trigger:** The scoreboard appears when less than 15% of the Live power card is visible (`onScrollVisibilityChange(threshold: 0.15)`). Pull-to-refresh overscroll at the top never triggers it.
- **Sports-style swap:** The scoreboard replaces the site name in the bar's center as a single row that fits the standard inline bar height. It doesn't sit under the name. The site name returns when the card is visible again.
- **Stat chips:** Each stat is a small glyph tinted like its Live card tile, followed by a bold value (`.subheadline.weight(.semibold)`, rounded design, `.monospacedDigit()`). Chips have 12 pt between them. There are no labels, sentences or timestamps.
  - **Battery (essential):** Uses the level glyph from `batterySymbol(powerWatts:stateOfCharge:)` in green, so the glyph works as a tiny gauge, with `"82%"`. If the battery is charging or discharging (role is not `.idle`), a smaller secondary value follows: `"+1.2 kW"` when charging, `"−1.2 kW"` when discharging (U+2212). That secondary value is the "battery usage" nice-to-have.
  - **Home (essential):** `house.fill` in blue with `power(load)`.
  - **Solar (essential):** `sun.max.fill` in orange with `power(solar)`. It always shows, including "0 W" at night.
  - **Grid (nice-to-have):** Shows only when the grid is importing or exporting. Importing uses `arrow.down.to.line` and exporting uses `arrow.up.to.line`, in gray, with the value shown without a sign. This matches the card.
- **Order:** Battery, home, solar, then grid. Battery, home and solar are the essentials, in the user's priority order.
- **Narrow bars:** `ViewThatFits(in: .horizontal)` tries three rows in turn:
  1. Everything.
  2. The essentials only (no grid, no battery-flow value).
  3. Battery and solar.

  The nice-to-haves are always the first to go.
- **Charge unknown:** The battery chip is left out, and home and solar still show.
- **Stale or unavailable:** If every card in the flow has role `.unknown` (stale over 15 minutes, request failed, or no data), there's no scoreboard and the bar keeps the site name. The stale banner and the card already explain why.
- **Motion:** The name and the scoreboard swap with `.opacity` plus `.move(edge: .bottom)` over 0.2 s, like Sports. With Reduce Motion on, the swap uses opacity only. Values use `.contentTransition(.numericText())` unless Reduce Motion is on.
- **VoiceOver:** The scoreboard is one element. Its label is the site name followed by the stats, for example "Harrison. Battery 82%, charging 1.2 kW, Home 900 W, Solar 4.0 kW, Exporting 2.0 kW".
- **Out of scope:** Tapping the scoreboard to scroll to the top (the status bar tap already does this). Other tabs. The iPad sidebar header.

## Global Constraints

- iOS deployment target stays 18.0. Don't use any API newer than that.
- Reuse `DashboardPresentation.power(_:)` for watt formatting and `batterySymbol` for the battery glyph. Don't add a second formatter.
- Stale and idle rules come from `powerFlow` (15-minute freshness, ±50 W grid and battery idle band). Don't duplicate them.
- New files use the kebab-case names of recent iOS files. XcodeGen picks them up: `run-tests.sh` regenerates the project, and the `.xcodeproj` is untracked.

## Review Focus

- **Night at full battery** (solar 0, grid and battery idle): show battery % with no flow value, home, and solar "0 W", with no grid. Test: `nightIdleScoreboard`.
- **Readings go stale while scrolled down:** the scoreboard falls back to the site name on the next 60 s `TimelineView` tick, not just on the next scroll. Test: `staleFlowHasNoScoreboard`, plus a manual check in Task 2.
- **Charge unknown but flow current:** the battery chip is left out, and home and solar still show. Test: `unknownChargeOmitsBattery`.
- **Accessibility text size:** chips never truncate mid-value. `ViewThatFits` drops to fewer chips instead. Manual check in Task 2 at AX3.
- **iPad two-column layout:** the Live card is in the top-left cell, so the same trigger applies, and the wide bar shows every chip. Manual check with the iPad preview.

---

### Task 1: Scoreboard model

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPresentation.swift` (add after `powerFlow`, around line 90)
- Test: `cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift`

**Interfaces:**
- Produces:
  ```swift
  extension DashboardPresentation {
      struct ScoreboardStat: Equatable {
          let symbol: String       // SF Symbol name
          let value: String        // "900 W", "4.0 kW", "82%"
          let spokenLabel: String  // "Home 900 W", "Exporting 2.0 kW"
      }
      struct BatteryScoreboardStat: Equatable {
          let symbol: String       // batterySymbol(powerWatts:stateOfCharge:)
          let charge: String       // "82%"
          let flow: String?        // "+1.2 kW" charging, "−1.2 kW" discharging, nil when idle
          let spokenLabel: String  // "Battery 82%, charging 1.2 kW" / "Battery 82%"
      }
      struct LiveScoreboard: Equatable {
          let battery: BatteryScoreboardStat?  // nil when charge unknown
          let home: ScoreboardStat
          let solar: ScoreboardStat
          let grid: ScoreboardStat?            // nil when idle
          func accessibilityLabel(siteName: String) -> String  // "<site>. <stats joined by ", ">"
      }
      static func liveScoreboard(flow: PowerFlow, stateOfCharge: Double?) -> LiveScoreboard?
  }
  ```
  `PowerCard.watts` has no sign. Take the direction from `role`: battery `.supplying` means discharging, and `.receiving` means charging. When calling `batterySymbol`, pass a signed value: `+watts` for supplying, `-watts` for receiving, `0` otherwise.

- [ ] **Step 1: Write the failing tests** (reuse the suite's `flow(solar:home:grid:battery:age:unavailable:)` helper)

```swift
@Test("Exporting midday fills every chip")
func exportingScoreboard() throws {
    let board = try #require(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 4000, home: 900, grid: -2000, battery: -1100), stateOfCharge: 82))
    #expect(board.battery?.charge == "82%")
    #expect(board.battery?.flow == "+1.1 kW")
    #expect(board.home.value == "900 W")
    #expect(board.solar.value == "4.0 kW")
    #expect(board.grid?.value == "2.0 kW")
    #expect(board.grid?.symbol == "arrow.up.to.line")
    #expect(board.accessibilityLabel(siteName: "Harrison")
        == "Harrison. Battery 82%, charging 1.1 kW, Home 900 W, Solar 4.0 kW, Exporting 2.0 kW")
}

@Test("Night at full battery keeps zero solar and drops idle extras")
func nightIdleScoreboard() throws {
    let board = try #require(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 0, home: 600, grid: 20, battery: 30), stateOfCharge: 100))
    #expect(board.solar.value == "0 W")
    #expect(board.grid == nil)
    #expect(board.battery?.flow == nil)
    #expect(board.battery?.spokenLabel == "Battery 100%")
}

@Test("Discharging battery and importing grid carry their directions")
func dischargingAndImporting() throws {
    let board = try #require(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 0, home: 4000, grid: 3000, battery: 1000), stateOfCharge: 40))
    #expect(board.battery?.flow == "\u{2212}1.0 kW")
    #expect(board.grid?.symbol == "arrow.down.to.line")
    #expect(board.grid?.spokenLabel == "Importing 3.0 kW")
}

@Test("Unknown charge omits only the battery chip")
func unknownChargeOmitsBattery() throws {
    let board = try #require(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 2000, home: 1000, grid: 0, battery: -1000), stateOfCharge: nil))
    #expect(board.battery == nil)
    #expect(board.solar.value == "2.0 kW")
}

@Test("Stale or unavailable flow has no scoreboard")
func staleFlowHasNoScoreboard() {
    #expect(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 2000, home: 1000, grid: 0, battery: 0, age: 16 * 60), stateOfCharge: 50) == nil)
    #expect(DashboardPresentation.liveScoreboard(
        flow: flow(solar: 2000, home: 1000, grid: 0, battery: 0, unavailable: true), stateOfCharge: 50) == nil)
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cmd/ios-app/run-tests.sh DashboardPresentationTests`
Expected: build failure, `liveScoreboard` not found

- [ ] **Step 3: Implement `liveScoreboard(flow:stateOfCharge:)`** using the rules in Design decisions. Return nil when every card is `.unknown`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cmd/ios-app/run-tests.sh DashboardPresentationTests`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/PWUsage/Views/DashboardPresentation.swift cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift
git commit -m "feat(ios): live scoreboard model for the Home bar"
```

### Task 2: Scoreboard in the Home bar

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/home-live-title.swift`
- Modify: `cmd/ios-app/PWUsage/Views/DashboardView.swift` (`body` lines 33–77, `liveSection(now:)` lines 119–184)

**Interfaces:**
- Consumes: `DashboardPresentation.liveScoreboard(flow:stateOfCharge:) -> LiveScoreboard?` and its stat types from Task 1.
- Produces:
  ```swift
  struct HomeLiveTitle: View {
      let siteName: String
      let scoreboard: DashboardPresentation.LiveScoreboard?  // nil = site name (.headline)
  }
  ```

- [ ] **Step 1: Create `HomeLiveTitle`.**
  - Show the site name `Text` when `scoreboard` is nil. Otherwise show `ViewThatFits(in: .horizontal)` over the three chip rows from Design decisions.
  - Each chip is an `HStack(spacing: 3)` with the glyph and the value, each with `lineLimit(1)` and `fixedSize()` so values never truncate.
  - The battery flow value is in `.caption.weight(.semibold)`, `.secondary`.
  - Swap the name and the scoreboard with an `.animation(..., value: scoreboard == nil)` and the transitions from Design decisions.
  - Add `#Preview`s for:
    - the site name only
    - every chip
    - essentials only, in a 200 pt-wide frame
    - AX3
- [ ] **Step 2: Track Live card visibility.** In `DashboardView`, add `@State private var liveCardIsVisible = true`. Then attach `.onScrollVisibilityChange(threshold: 0.15) { liveCardIsVisible = $0 }` to the `VStack` that `liveSection(now:)` returns, so the loading and unavailable states also count as the card.
- [ ] **Step 3: Put the title in the bar.**
  - In `body`, after `.inlineNavigationTitle()`, add a toolbar item:
    ```swift
    .toolbar {
        ToolbarItem(placement: .principal) {
            TimelineView(.periodic(from: .now, by: 60)) { _ in
                HomeLiveTitle(siteName: site.name,
                              scoreboard: liveCardIsVisible ? nil : liveScoreboard(now: .now))
            }
        }
    }
    ```
  - Pull the `powerFlow(...)` and validated-charge work in `liveSection(now:)` into `private func liveReadings(now: Date) -> (flow: DashboardPresentation.PowerFlow, charge: Double?)?`. Then the card and `private func liveScoreboard(now:)` both call it instead of each building it.
  - Keep `.navigationTitle(site.name)`.
- [ ] **Step 4: Build and run all tests**

Run: `cmd/ios-app/run-tests.sh`
Expected: build succeeds and all tests PASS

- [ ] **Step 5: Verify in the Simulator**

Launch the app on an iPhone simulator with the preview or the Harrison site, and screenshot each of these:
1. At rest, the bar shows the site name.
2. Scrolling until the Live card is gone swaps in the scoreboard.
3. Scrolling back restores the name.
4. Pull-to-refresh never shows the scoreboard.
5. At AX3, chips drop and none truncate.
6. On the iPad preview, every chip shows.

- [ ] **Step 6: Commit**

```bash
git add cmd/ios-app/PWUsage/Views/home-live-title.swift cmd/ios-app/PWUsage/Views/DashboardView.swift
git commit -m "feat(ios): Sports-style live scoreboard in the Home bar"
```
