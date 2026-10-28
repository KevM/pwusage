import Foundation
@testable import PWUsage
import Testing
import UIKit

@Suite("Live Scoreboard Tests")
struct LiveScoreboardTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func flow(solar: Double, home: Double, grid: Double, battery: Double,
                      age: TimeInterval = 0, unavailable: Bool = false) -> DashboardPresentation.PowerFlow {
        DashboardPresentation.powerFlow(
            solarPower: solar, loadPower: home, batteryPower: battery, gridPower: grid,
            sourceTime: now.addingTimeInterval(-age), isUnavailable: unavailable, now: now
        )
    }

    @Test("Exporting midday fills every scoreboard chip")
    func exportingScoreboard() throws {
        let board = try #require(DashboardPresentation.liveScoreboard(
            flow: flow(solar: 4000, home: 900, grid: -2000, battery: -1100), stateOfCharge: 82
        ))
        #expect(board.battery?.charge == "82%")
        #expect(board.battery?.flow == "+1.1 kW")
        #expect(board.battery?.symbol == "battery.75percent")
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
            flow: flow(solar: 0, home: 600, grid: 20, battery: 30), stateOfCharge: 100
        ))
        #expect(board.solar.value == "0 W")
        #expect(board.grid == nil)
        #expect(board.battery?.flow == nil)
        #expect(board.battery?.spokenLabel == "Battery 100%")
    }

    @Test("A negative solar reading at night shows unknown, not its magnitude")
    func negativeSolarShowsUnknown() throws {
        let board = try #require(DashboardPresentation.liveScoreboard(
            flow: flow(solar: -8, home: 600, grid: 0, battery: 600), stateOfCharge: 60
        ))
        #expect(board.solar.value == "--")
        #expect(board.home.value == "600 W")
    }

    @Test("Discharging battery and importing grid carry their directions")
    func dischargingAndImporting() throws {
        let board = try #require(DashboardPresentation.liveScoreboard(
            flow: flow(solar: 0, home: 4000, grid: 3000, battery: 1000), stateOfCharge: 40
        ))
        #expect(board.battery?.flow == "\u{2212}1.0 kW")
        #expect(board.battery?.spokenLabel == "Battery 40%, discharging 1.0 kW")
        #expect(board.grid?.symbol == "arrow.down.to.line")
        #expect(board.grid?.spokenLabel == "Importing 3.0 kW")
    }

    @Test("Unknown charge omits only the battery chip")
    func unknownChargeOmitsBattery() throws {
        let board = try #require(DashboardPresentation.liveScoreboard(
            flow: flow(solar: 2000, home: 1000, grid: 0, battery: -1000), stateOfCharge: nil
        ))
        #expect(board.battery == nil)
        #expect(board.solar.value == "2.0 kW")
    }

    @Test("Stale or unavailable flow has no scoreboard")
    func staleFlowHasNoScoreboard() {
        #expect(DashboardPresentation.liveScoreboard(
            flow: flow(solar: 2000, home: 1000, grid: 0, battery: 0, age: 16 * 60), stateOfCharge: 50
        ) == nil)
        #expect(DashboardPresentation.liveScoreboard(
            flow: flow(solar: 2000, home: 1000, grid: 0, battery: 0, unavailable: true), stateOfCharge: 50
        ) == nil)
    }

    @Test("The Live card counts as gone once under 15% shows below the bar")
    func liveCardVisibilityBelowBar() {
        // A 400 pt card from 50 to 450 in scroll content; 15% is 60 pt.
        func visible(_ top: Double) -> Bool {
            DashboardPresentation.liveCardIsVisible(cardMinY: 50, cardMaxY: 450, visibleTop: top)
        }
        #expect(visible(-80)) // pull-to-refresh overscroll
        #expect(visible(0))
        #expect(visible(390)) // exactly 60 pt still shows
        #expect(!visible(391))
        #expect(!visible(900))
        // Before the card is measured, keep the site name.
        #expect(DashboardPresentation.liveCardIsVisible(cardMinY: 0, cardMaxY: 0, visibleTop: 500))
    }

    @Test("Every battery symbol is a real SF Symbol, charging or not")
    func batterySymbolsResolve() {
        // SF Symbols has a bolt only on the full battery; a missing name draws nothing.
        for charge in stride(from: 0.0, through: 100.0, by: 1.0) {
            for watts in [-900.0, 0.0, 900.0] {
                let name = DashboardPresentation.batterySymbol(powerWatts: watts, stateOfCharge: charge)
                #expect(UIImage(systemName: name) != nil, "\(name) does not exist")
            }
        }
    }
}
