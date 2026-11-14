import Foundation
@testable import PWUsage
import Testing

@Suite("BillShadowComparison")
struct BillShadowComparisonTests {
    private static let cycleStart = Date(timeIntervalSince1970: 1_759_302_000)
    private static let cycleEnd = Date(timeIntervalSince1970: 1_761_980_400)

    private func makeBill(estimatedCost: Double?, periods: [Period]) -> MobileBillResponse {
        MobileBillResponse(
            version: 1,
            site: MobileBillResponse.Site(id: "site-1", name: "Home", timezone: "America/Los_Angeles"),
            currentBill: MobileBillResponse.Bill(
                estimatedCost: estimatedCost,
                currency: "USD",
                cycleStart: Self.cycleStart,
                cycleEnd: Self.cycleEnd,
                periods: periods
            ),
            loadTiming: nil,
            tariffReattribution: nil,
            sources: MobileBillResponse.Sources(calculatedAt: Self.cycleStart, energyDataThrough: nil)
        )
    }

    @Test("Returns nil when estimatedCost and all periods are within one cent")
    func nilWhenWithinOneCent() {
        let server = makeBill(
            estimatedCost: 10.00,
            periods: [
                Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 6.00),
                Period(tariffName: "TOU-D", periodName: "Off Peak", netGridKwh: 20, cost: 4.00)
            ]
        )
        let local = makeBill(
            estimatedCost: 10.005,
            periods: [
                Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 6.004),
                Period(tariffName: "TOU-D", periodName: "Off Peak", netGridKwh: 20, cost: 4.001)
            ]
        )

        #expect(BillShadowComparison.differences(server: server, local: local) == nil)
    }

    @Test("Reports when a period or total differs by more than one cent")
    func reportsPeriodsOverOneCent() throws {
        let server = makeBill(
            estimatedCost: 10.00,
            periods: [Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 10.00)]
        )
        let local = makeBill(
            estimatedCost: 10.05,
            periods: [Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 10.05)]
        )

        let report = try #require(BillShadowComparison.differences(server: server, local: local))
        #expect(report.siteId == "site-1")
        #expect(report.cycleStart == Self.cycleStart)
        #expect(report.server.estimatedCost == 10.00)
        #expect(report.local.estimatedCost == 10.05)
        #expect(report.server.periods.count == 1)
        #expect(report.local.periods.count == 1)
    }

    @Test("Reports when a period is present on one side only")
    func reportsAPeriodPresentOnOneSideOnly() throws {
        let server = makeBill(
            estimatedCost: 10.00,
            periods: [
                Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 10.00),
                Period(tariffName: "TOU-D", periodName: "Super Off Peak", netGridKwh: 0, cost: 0.00)
            ]
        )
        let local = makeBill(
            estimatedCost: 10.00,
            periods: [
                Period(tariffName: "TOU-D", periodName: "Peak", netGridKwh: 10, cost: 10.00)
            ]
        )

        let report = try #require(BillShadowComparison.differences(server: server, local: local))
        #expect(report.server.periods.count == 2)
        #expect(report.local.periods.count == 1)
    }

    @Test("Totals each day's grid energy inside the cycle and keeps its last slot")
    func dailyTotalsSumGridPerDayAndKeepLastSlot() throws {
        let dayStart = Self.cycleStart
        var grid = [Float?](repeating: nil, count: 288)
        grid[0] = 1.5
        grid[1] = -0.5
        grid[3] = 2
        let day = EnergyFlowDay(
            day: "2025-10-01",
            dayStart: dayStart,
            solarWh: [],
            loadWh: [],
            gridWh: grid,
            batteryWh: [],
            batterySoc: []
        )
        let empty = EnergyFlowDay(
            day: "2025-10-02",
            dayStart: dayStart.addingTimeInterval(86_400),
            solarWh: [],
            loadWh: [],
            gridWh: [Float?](repeating: nil, count: 288),
            batteryWh: [],
            batterySoc: []
        )

        let totals = BillShadowComparison.dailyTotals([day, empty], from: Self.cycleStart, to: Self.cycleEnd)

        #expect(totals == [
            BillShadowDay(day: "2025-10-01", gridWh: 3, last: dayStart.addingTimeInterval(900)),
            BillShadowDay(day: "2025-10-02", gridWh: 0, last: nil)
        ])
    }

    @Test("Sends the phone's days with the report, as the server expects them")
    func reportEncodesLocalDays() throws {
        let server = makeBill(estimatedCost: 10.00, periods: [])
        let local = makeBill(estimatedCost: 9.00, periods: [])
        let days = [BillShadowDay(day: "2025-10-01", gridWh: 3, last: Self.cycleStart)]

        let report = try #require(BillShadowComparison.differences(server: server, local: local, localDays: days))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = try #require(
            JSONSerialization.jsonObject(with: encoder.encode(report)) as? [String: Any]
        )
        let encodedDays = try #require(json["localDays"] as? [[String: Any]])
        #expect(encodedDays.count == 1)
        #expect(encodedDays.first?["day"] as? String == "2025-10-01")
        #expect(encodedDays.first?["gridWh"] as? Double == 3)
        #expect(encodedDays.first?["last"] as? String == "2025-10-01T07:00:00Z")
    }
}
