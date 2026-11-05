import Foundation
@testable import PWUsage
import SwiftUI
import Testing

struct BillOutlookPresentationTests {
    @Test func dateSelectionDefaultsToLastCompletePointAfterHistoryGap() {
        let first = BillOutlook.point(date: .init(timeIntervalSince1970: 0), buckets: [])
        let last = BillOutlook.point(date: .init(timeIntervalSince1970: 86400), buckets: [])
        #expect(BillOutlookPresentation.selection(in: [first, last], date: nil) == last)
        #expect(BillOutlookPresentation.selection(in: [], date: nil) == nil)
    }
    @Test func daysLeftUsesLocalCalendarDaysAcrossDST() throws {
        let formatter = ISO8601DateFormatter()
        let now = try #require(formatter.date(from: "2026-11-01T05:00:00Z"))
        let end = try #require(formatter.date(from: "2026-11-02T06:00:00Z"))
        #expect(BillOutlookPresentation.daysLeft(now: now, end: end, timeZone: "America/Chicago") == 1)
        #expect(BillOutlookPresentation.daysLeft(now: end, end: end, timeZone: "America/Chicago") == nil)
    }
    @Test func daysLeftLabelReadsAtAGlance() {
        #expect(BillOutlookPresentation.daysLeftLabel(0) == "Ends today")
        #expect(BillOutlookPresentation.daysLeftLabel(1) == "1 day left")
        #expect(BillOutlookPresentation.daysLeftLabel(6) == "6 days left")
    }
    @Test func projectionLabelNamesADateOnlyWhenTheForecastStopsShort() throws {
        let formatter = ISO8601DateFormatter()
        let projectedEnd = try #require(formatter.date(from: "2026-11-07T12:00:00Z"))
        let locale = Locale(identifier: "en_US")
        #expect(BillOutlookPresentation.projectionLabel(projectedEnd: projectedEnd, cycleEnd: projectedEnd,
                                                        timeZone: "UTC", locale: locale) == "By cycle end")
        #expect(BillOutlookPresentation.projectionLabel(projectedEnd: projectedEnd,
                                                        cycleEnd: projectedEnd.addingTimeInterval(86400),
                                                        timeZone: "UTC", locale: locale) == "By Nov 7")
    }
    @Test func projectedAmountRoundsToWholeUnits() {
        let amount = BillOutlookPresentation.projectedAmount(112.4, currency: "USD",
                                                             locale: Locale(identifier: "en_US"))
        #expect(amount == "about $112")
    }
    @Test func fillFractionOnlyDrawsWhatTheBarCanShow() {
        #expect(BillOutlookPresentation.fillFraction(soFar: 84, projected: 112) == 0.75)
        #expect(BillOutlookPresentation.fillFraction(soFar: 0, projected: 112) == 0)
        #expect(BillOutlookPresentation.fillFraction(soFar: 120, projected: 112) == nil)
        #expect(BillOutlookPresentation.fillFraction(soFar: -4, projected: 112) == nil)
        #expect(BillOutlookPresentation.fillFraction(soFar: 10, projected: 0) == nil)
    }
    @Test func projectionBasisNamesTheSources() {
        #expect(BillOutlookPresentation.projectionBasis(usesSolar: false, usesHistory: true)
            == "Based on your recent grid history.")
        #expect(BillOutlookPresentation.projectionBasis(usesSolar: true, usesHistory: false)
            == "Based on the solar forecast and typical home use.")
    }
    @Test func laneSummaryDefaultsToTheBillTotalSoFar() {
        let totals = [Period(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 97.5, cost: 9.75),
                      Period(tariffName: "Home", periodName: "On-Peak", netGridKwh: -14.7, cost: -0.59)]
        let offPeak = BillOutlookPeriod(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 240.3)
        let summary = BillOutlookPresentation.laneSummary(period: offPeak, totals: totals, selected: nil)
        #expect(summary == "Import gap · 97.5 kWh")
    }
    @Test func laneSummaryShowsTheSelectedDay() {
        let totals = [Period(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 97.5, cost: 9.75)]
        let offPeak = BillOutlookPeriod(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 0)
        let selected = BillOutlookPeriod(tariffName: "Home", periodName: "Off-Peak", netGridKwh: -12.4)
        let summary = BillOutlookPresentation.laneSummary(period: offPeak, totals: totals, selected: selected)
        #expect(summary == "Export cushion · 12.4 kWh")
    }
    @Test func laneSummaryIsEmptyWhenThePeriodHasNoTotalYet() {
        let offPeak = BillOutlookPeriod(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 0)
        #expect(BillOutlookPresentation.laneSummary(period: offPeak, totals: [], selected: nil) == nil)
    }
    private struct Rate {
        let name: String
        let buy: Double
        let sell: Double
    }
    private static let onPeak = Rate(name: "On-Peak", buy: 0.30, sell: 0.04)
    private static let offPeak = Rate(name: "Off-Peak", buy: 0.10, sell: 0.04)
    private static func balances(offPeak: Double, onPeak: Double, plan: String = "Home") -> BillOutlookPoint {
        BillOutlook.point(date: .init(timeIntervalSince1970: 0), buckets: [
            .init(tariffName: "Home", periodName: Self.offPeak.name, netGridKwh: offPeak,
                  buyRate: Self.offPeak.buy, sellRate: Self.offPeak.sell),
            .init(tariffName: plan, periodName: Self.onPeak.name, netGridKwh: onPeak,
                  buyRate: Self.onPeak.buy, sellRate: Self.onPeak.sell)
        ])
    }
    private static func remaining(_ periods: [Rate]) -> [BillOutlookTariff] {
        periods.enumerated().map { index, period in
            .init(start: .init(timeIntervalSince1970: Double(index) * 3600),
                  end: .init(timeIntervalSince1970: Double(index + 1) * 3600),
                  periodKey: period.name, name: period.name, buyRate: period.buy, sellRate: period.sell,
                  tariffName: "Home", periodName: period.name)
        }
    }
    private static let usd = Locale(identifier: "en_US")
    private static func move(projected: BillOutlookPoint, remaining: [BillOutlookTariff],
                             daysLeft: Int? = 6) -> BillSavingsMove? {
        BillOutlookPresentation.savingsMove(projected: [projected], remaining: remaining,
                                            cycleEnd: projected.date, daysLeft: daysLeft)
    }
    private static let bothPeriods = remaining([offPeak, onPeak])

    @Test func moveGoesFromTheGapIntoTheLowValueCushion() throws {
        let move = try #require(Self.move(projected: Self.balances(offPeak: 340, onPeak: -30),
                                          remaining: Self.bothPeriods))
        #expect(move.source == .init(periodName: "Off-Peak", rate: 0.10, role: .pay))
        #expect(move.destination == .init(periodName: "On-Peak", rate: 0.04, role: .onlyEarn))
        #expect(move.energyKwh == 30)
        #expect(abs(move.savings - 1.80) < 0.001)
        #expect(move.rowHeadline(currency: "USD", locale: Self.usd) == "Could save about $1.80")
        #expect(move.amount(currency: "USD", locale: Self.usd) == "about $1.80")
        #expect(move.headline == "Run heavy energy use in On-Peak")
        #expect(move.rateText(for: move.source, currency: "USD", locale: Self.usd) == "10¢")
        #expect(move.source.role.caption == "you pay")
        #expect(move.destination.role.caption == "you'd only earn")
        #expect(move.energyText == "30.0 kWh")
        #expect(move.accessibilityLabel(currency: "USD", locale: Self.usd)
            == "Moving about 30.0 kWh of use from Off-Peak, where you pay 10¢/kWh, "
            + "to On-Peak, where you'd only earn 4¢/kWh.")
    }
    @Test func moveWorksInTheOppositeDirection() throws {
        let move = try #require(Self.move(projected: Self.balances(offPeak: -30, onPeak: 340),
                                          remaining: Self.bothPeriods))
        #expect(move.source == .init(periodName: "On-Peak", rate: 0.30, role: .pay))
        #expect(move.destination == .init(periodName: "Off-Peak", rate: 0.04, role: .onlyEarn))
        #expect(move.headline == "Run heavy energy use in Off-Peak")
    }
    @Test func moveIsCappedAtTheImportGap() throws {
        let move = try #require(Self.move(projected: Self.balances(offPeak: 10, onPeak: -30),
                                          remaining: Self.bothPeriods))
        #expect(move.energyKwh == 10)
        #expect(abs(move.savings - 0.60) < 0.001)
    }
    @Test func moveStaysHiddenUntilTheLastWeekOfTheCycle() {
        let projected = Self.balances(offPeak: 340, onPeak: -30)
        #expect(Self.move(projected: projected, remaining: Self.bothPeriods, daysLeft: 7) != nil)
        #expect(Self.move(projected: projected, remaining: Self.bothPeriods, daysLeft: 8) == nil)
        #expect(Self.move(projected: projected, remaining: Self.bothPeriods, daysLeft: nil) == nil)
    }
    @Test func moveNeedsAProjectionThatReachesTheCycleEnd() {
        let projected = Self.balances(offPeak: 340, onPeak: -30)
        let move = BillOutlookPresentation.savingsMove(projected: [projected], remaining: Self.bothPeriods,
                                                       cycleEnd: projected.date.addingTimeInterval(86400),
                                                       daysLeft: 1)
        #expect(move == nil)
    }
    @Test func noMoveWhenTheCushionPeriodIsOver() {
        #expect(Self.move(projected: Self.balances(offPeak: 340, onPeak: -30),
                          remaining: Self.remaining([Self.offPeak])) == nil)
    }
    @Test func noMoveWhenTheCushionIsWorthMoreThanTheImportsCost() {
        let richCredit = Rate(name: "On-Peak", buy: 0.30, sell: 0.20)
        let projected = BillOutlook.point(date: .init(timeIntervalSince1970: 0), buckets: [
            .init(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 340, buyRate: 0.10, sellRate: 0.04),
            .init(tariffName: "Home", periodName: "On-Peak", netGridKwh: -30, buyRate: 0.30, sellRate: 0.20)
        ])
        #expect(Self.move(projected: projected, remaining: Self.remaining([Self.offPeak, richCredit])) == nil)
    }
    @Test func noMoveAcrossPlans() {
        #expect(Self.move(projected: Self.balances(offPeak: 340, onPeak: -30, plan: "Old plan"),
                          remaining: Self.bothPeriods) == nil)
    }
    @Test func noMoveForASavingTooSmallToAct() {
        #expect(Self.move(projected: Self.balances(offPeak: 340, onPeak: -2), remaining: Self.bothPeriods) == nil)
    }
}

@MainActor
struct BillOutlookRenderTests {
    @Test func renderChartAtStandardAndAccessibilitySizes() throws {
        let start = Date(timeIntervalSince1970: 1_792_368_000)
        let now = start.addingTimeInterval(20 * 86400)
        let end = start.addingTimeInterval(25 * 86400)
        func point(_ day: Int) -> BillOutlookPoint {
            BillOutlook.point(date: start.addingTimeInterval(Double(day) * 86400), buckets: [
                .init(tariffName: "Home", periodName: "Peak", netGridKwh: Double(day < 20 ? day : 40 - day) * 0.6,
                      buyRate: 0.4, sellRate: 0.04),
                .init(tariffName: "Home", periodName: "Off-Peak", netGridKwh: -Double(day) * 1.2,
                      buyRate: 0.12, sellRate: 0.04)])
        }
        let history = BillOutlookHistory(points: (0 ... 20).map(point),
                                         observedThrough: now,
                                         complete: true,
                                         tariffTimeline: [])
        for large in [false, true] {
            let chart = BillOutlookChart(
                history: history,
                projected: (20 ... 25).map(point),
                cycleStart: start,
                cycleEnd: end,
                now: now,
                timeZone: "America/Chicago",
                currency: "USD",
                totals: [
                    .init(tariffName: "Home", periodName: "Peak", netGridKwh: 12, cost: 4.8),
                    .init(tariffName: "Home", periodName: "Off-Peak", netGridKwh: -24, cost: -0.96)
                ]
            )
            .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
            .environment(\.colorScheme, .light).frame(width: 353).padding(20)
            .background(Color(uiColor: .systemGroupedBackground))
            let renderer = ImageRenderer(content: chart)
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            let data = try #require(image.pngData())
            let directory = URL(fileURLWithPath: "/tmp/pwusage-bill-outlook-renders", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("bill-outlook-\(large ? "large" : "standard").png")
            try data.write(to: url)
            print("Bill outlook render: \(url.path)")
            #expect(image.size.height > 300)
        }
    }

    private func render(_ view: some View, named name: String) throws {
        let renderer = ImageRenderer(content: view.frame(width: 353).padding(20)
            .background(Color(uiColor: .systemGroupedBackground)))
        renderer.scale = 2
        let image = try #require(renderer.uiImage)
        let directory = URL(fileURLWithPath: "/tmp/pwusage-bill-outlook-renders", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try #require(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
        #expect(image.size.height > 60)
    }

    @Test func renderHeaderStates() throws {
        let amount = BillEstimateHeader.Projection.amount(112.4, label: "By cycle end")
        let states: [String: BillEstimateHeader.Projection] = ["amount": amount, "pending": .pending, "none": .none]
        for (name, projection) in states {
            for scheme in [ColorScheme.light, .dark] {
                let fraction = projection == amount ? 0.75 : (projection == .pending ? 0 : nil)
                let header = BillEstimateHeader(soFar: 84.12, currency: "USD", projection: projection,
                                                fillFraction: fraction, daysLeft: "4 days left",
                                                animatesReveal: false)
                    .environment(\.colorScheme, scheme)
                try render(header, named: "header-\(name)-\(scheme == .dark ? "dark" : "light")")
            }
        }
    }

    @Test func renderRatePeriodTotals() throws {
        let periods = [Period(tariffName: "Home", periodName: "Off-Peak", netGridKwh: 180.9, cost: 18.09),
                       Period(tariffName: "Home", periodName: "On-Peak", netGridKwh: -13.1, cost: -0.52)]
        for scheme in [ColorScheme.light, .dark] {
            let totals = BillRatePeriodTotals(periods: periods, currency: "USD").environment(\.colorScheme, scheme)
            try render(totals, named: "totals-\(scheme == .dark ? "dark" : "light")")
        }
    }

    @Test func renderSavingsFlowAtStandardAndAccessibilitySizes() throws {
        let move = BillSavingsMove(source: .init(periodName: "Off-Peak", rate: 0.10, role: .pay),
                                   destination: .init(periodName: "On-Peak", rate: 0.04, role: .onlyEarn),
                                   energyKwh: 13.1, savings: 0.79)
        for large in [false, true] {
            let flow = BillSavingsFlow(move: move, currency: "USD")
                .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
            try render(flow, named: "flow-\(large ? "large" : "standard")")
        }
        let long = BillSavingsMove(source: .init(periodName: "Winter On-Peak Shoulder", rate: 0.24, role: .pay),
                                   destination: .init(periodName: "Super Off-Peak", rate: 0.03, role: .onlyEarn),
                                   energyKwh: 15, savings: 3.15)
        try render(BillSavingsFlow(move: long, currency: "USD"), named: "flow-long-names")
    }
}
