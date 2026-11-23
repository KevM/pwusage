import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

/// The demo answers every request from memory. The hold is its one interactive
/// action, so it has to start, stop and expire like the real one.
@MainActor
@Suite("Demo API")
struct DemoAPITests {
    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_793_000_000)
    }

    private let clock = Clock()
    private var api: DemoAPI {
        let clock = clock
        return DemoAPI(now: { clock.now })
    }

    private static func timer(_ hours: Int) -> BatteryHoldCommand {
        .park(BatteryHoldChoice(mode: .timer, durationHours: hours))
    }

    @Test("Serves the demo home")
    func servesDemoSite() async throws {
        let api = api
        #expect(try await api.fetchSites() == [DemoFixtures.site])
        #expect(try await api.fetchBill(siteID: DemoFixtures.site.id).site.name == "Cedar House")
        #expect(try await api.fetchLive(siteID: DemoFixtures.site.id).site.name == "Cedar House")
        _ = try await api.fetchTariffTimeline(siteID: DemoFixtures.site.id).validating(siteID: DemoFixtures.site.id)
        let context = try await api.fetchLoadPlanningContext(siteID: DemoFixtures.site.id)
        _ = try context.validating(siteID: DemoFixtures.site.id, now: clock.now)
        let history = try await api.fetchSolarHistory(siteID: DemoFixtures.site.id, from: "", changedSince: nil)
        guard case .enabled(let zone, let days, let nextFrom) = history else {
            Issue.record("Demo solar history must be enabled")
            return
        }
        #expect(zone == DemoFixtures.timeZone)
        #expect(nextFrom == nil)
        #expect(!days.isEmpty)
        #expect(days.last?.status == .open)
    }

    /// Minute timelines render with the minute's start, so a source inside the
    /// current minute would read as in the future.
    @Test("Every fetch shares one source instant two minutes back")
    func sourceIsBeforeTheCurrentMinute() async throws {
        let api = api
        let live = try await api.fetchLive(siteID: DemoFixtures.site.id).sources.liveStatusAt
        let bill = try await api.fetchBill(siteID: DemoFixtures.site.id).sources.energyDataThrough
        #expect(live == bill)
        #expect(live == clock.now.addingTimeInterval(-120))
        #expect(api.launchedAt == clock.now.addingTimeInterval(-120))
    }

    /// A long review session must not age out of the balance freshness windows.
    @Test("The source instant follows the clock in a long session")
    func sourceFollowsTheClock() async throws {
        let api = api
        clock.now += 3600
        let live = try await api.fetchLive(siteID: DemoFixtures.site.id).sources.liveStatusAt
        #expect(live == clock.now.addingTimeInterval(-120))
    }

    @Test("Parking starts a timed hold")
    func parkStartsHold() async throws {
        let api = api
        let result = try await api.sendBatteryHoldCommand(siteID: DemoFixtures.site.id, command: Self.timer(2))
            .validating(siteID: DemoFixtures.site.id, command: Self.timer(2))
        #expect(result.hold != nil)
        let hold = try #require(try await api.fetchBatteryHold(siteID: DemoFixtures.site.id).hold)
        _ = try hold.validating(siteID: DemoFixtures.site.id, status: .active)
        #expect(hold.status == .active)
        #expect(hold.safetyExpiresAt == clock.now.addingTimeInterval(2 * 3600))
        // The sheet offers to hold at the live charge, so the hold keeps that charge.
        #expect(hold.targetReserve == DemoFixtures.stateOfCharge)
    }

    @Test("Restoring ends the hold")
    func restoreEndsHold() async throws {
        let api = api
        _ = try await api.sendBatteryHoldCommand(siteID: DemoFixtures.site.id, command: Self.timer(2))
        _ = try await api.sendBatteryHoldCommand(siteID: DemoFixtures.site.id, command: .restore)
            .validating(siteID: DemoFixtures.site.id, command: .restore)
        #expect(try await api.fetchBatteryHold(siteID: DemoFixtures.site.id).hold == nil)
    }

    @Test("A hold left running ends on its own")
    func holdExpiresOnItsOwn() async throws {
        let api = api
        _ = try await api.sendBatteryHoldCommand(siteID: DemoFixtures.site.id, command: Self.timer(1))
        clock.now += 3601
        #expect(try await api.fetchBatteryHold(siteID: DemoFixtures.site.id).hold == nil)
    }

    @Test("An automatic hold lasts at most eight hours")
    func autoHoldLastsEightHours() async throws {
        let api = api
        _ = try await api.sendBatteryHoldCommand(siteID: DemoFixtures.site.id,
                                                 command: .park(BatteryHoldChoice(mode: .auto)))
        let hold = try #require(try await api.fetchBatteryHold(siteID: DemoFixtures.site.id).hold)
        #expect(hold.mode == .auto)
        #expect(hold.safetyExpiresAt == clock.now.addingTimeInterval(8 * 3600))
    }

    @Test("AI handoff exports a valid demo sample prompt and rejects imports cleanly")
    func aiHandoffExportsDemoPromptAndRejectsImport() async throws {
        let api = api
        let exported = try await api.exportRatePlanAiHandoff(siteID: DemoFixtures.site.id)
        #expect(exported.markdown.contains("Demo Mode Sample"))
        #expect(exported.markdown.contains(DemoFixtures.demoUtilityName))
        #expect(exported.filename.hasPrefix("pwusage-demo-rate-plans-"))

        let extracted = RatePlanAiHandoffModel.extractValidatedJSON(from: exported.markdown)
        guard case .success(let json) = extracted else {
            Issue.record("Expected valid handoff JSON in demo export")
            return
        }
        #expect(json.contains(RatePlanAiHandoffModel.expectedSchema))

        do {
            _ = try await api.previewRatePlanAiHandoff(siteID: DemoFixtures.site.id, rawInput: json)
            Issue.record("Expected demo AI import preview to reject")
        } catch PWUsageAPIError.requestRejected(let statusCode, let message) {
            #expect(statusCode == 403)
            #expect(message?.contains("demo") == true)
        }
    }

    @Test("Setting the billing day updates the demo site and bill cycle")
    func billingDayUpdatesDemoSiteAndCycle() async throws {
        let api = api
        let saved = try await api.setBillingDay(siteID: DemoFixtures.site.id, day: 15)
        #expect(saved == MobileBillingDay(billingDay: 15, billingDayConfirmed: true))
        #expect(try await api.fetchSites().first?.billingDay == 15)

        let bill = try await api.fetchBill(siteID: DemoFixtures.site.id)
        let expected = BillingCycle.current(billingDay: 15, now: api.launchedAt, timeZone: DemoFixtures.timeZone)
        #expect(bill.currentBill.cycleStart == expected.start)
        #expect(bill.currentBill.cycleEnd == expected.end)

        await #expect(throws: PWUsageAPIError.self) {
            _ = try await api.setBillingDay(siteID: DemoFixtures.site.id, day: 0)
        }
    }

    @Test("Trmnl shows the no-devices intro state with a real TRMNL framework preview")
    func trmnlShowsIntroStateWithDefaultPreview() async throws {
        let api = api
        #expect(try await api.fetchTrmnlDevices(siteID: DemoFixtures.site.id).isEmpty)

        let html = try await api.fetchTrmnlPreview(siteID: DemoFixtures.site.id, screen: nil)
        #expect(html.contains("https://trmnl.com/css/\(DemoTrmnlPreview.frameworkVersion)/plugins.css"))
        #expect(html.contains("<body class=\"environment trmnl\"><div class=\"screen\">"))
        #expect(html.contains(DemoFixtures.site.name))
        #expect(html.contains("Total Cost"))
        #expect(html.contains("Wait until Off-peak in 3 hours"))
        #expect(html.contains("\(DemoFixtures.stateOfCharge)%"))
    }
}
