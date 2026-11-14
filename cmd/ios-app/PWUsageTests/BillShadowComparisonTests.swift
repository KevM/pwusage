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
}
