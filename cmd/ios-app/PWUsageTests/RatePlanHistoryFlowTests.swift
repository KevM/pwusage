import Foundation
@testable import PWUsage
import Testing

@Suite("Rate plan history walk-back")
struct RatePlanHistoryFlowTests {
    // MARK: - Fixtures (Harrison: We Energies, history 2023-11-14, Tesla from 2026-04-28)

    static let timeOfUseName = "Residential Time-of-Use Rg 2"
    static let fixedName = "Residential Rg 1"

    static func windows(_ year: Int) -> [RatePlanPeakWindowDTO] {
        [
            RatePlanPeakWindowDTO(label: "Rg 2 Option A \(year)", fromHour: 7, toHour: 19),
            RatePlanPeakWindowDTO(label: "Rg 2 Option B \(year)", fromHour: 8, toHour: 20),
            RatePlanPeakWindowDTO(label: "Rg 2 Option C \(year)", fromHour: 9, toHour: 21)
        ]
    }

    static func timeOfUse(_ year: Int, closest: Bool = true) -> RatePlanHistoryPlanDTO {
        RatePlanHistoryPlanDTO(
            name: timeOfUseName, startDate: "\(year)-01-01", kind: .timeOfUse, isDefault: false,
            closest: closest, lowRate: 0.1, highRate: 0.3, peakWindows: windows(year),
            closestWindow: closest ? "Rg 2 Option B \(year)" : nil, fixedLabel: nil
        )
    }

    static func fixed(_ year: Int, name: String = fixedName, isDefault: Bool = true) -> RatePlanHistoryPlanDTO {
        RatePlanHistoryPlanDTO(
            name: name, startDate: "\(year)-01-01", kind: .fixed, isDefault: isDefault,
            closest: false, lowRate: 0.18, highRate: 0.18, peakWindows: [],
            closestWindow: nil, fixedLabel: "\(name) \(year)"
        )
    }

    static func year(_ year: Int, _ plans: [RatePlanHistoryPlanDTO]? = nil) -> RatePlanHistoryYearDTO {
        RatePlanHistoryYearDTO(
            year: year,
            askDate: year == 2023 ? "2023-11-14" : "\(year)-07-01",
            plans: plans ?? [timeOfUse(year), fixed(year)]
        )
    }

    static func harrison(
        current: [RatePlanHistoryPlanDTO]? = nil,
        years: [RatePlanHistoryYearDTO]? = nil,
        fillThrough: String? = "2026-04-27",
        teslaShape: RatePlanKind? = .timeOfUse
    ) -> RatePlanHistoryDTO {
        RatePlanHistoryDTO(
            utilityName: "We Energies",
            historyStart: "2023-11-14",
            fillThrough: fillThrough,
            teslaShape: teslaShape,
            current: current ?? [timeOfUse(2026), fixed(2026)],
            years: years ?? [year(2025), year(2024), year(2023)]
        )
    }

    static func optionB(_ year: Int) -> RatePlanPeakWindowDTO {
        windows(year)[1]
    }

    /// Picks Time of Use, Option B, as the current plan.
    static func onOptionB(_ history: RatePlanHistoryDTO = harrison()) -> RatePlanHistoryFlow {
        var flow = RatePlanHistoryFlow(history: history, hasTeslaPlan: true)
        flow.chooseKind(.timeOfUse)
        flow.choosePeakWindow(optionB(2026))
        return flow
    }

    // MARK: - First steps

    @Test func preselectsTeslaShape() {
        let flow = RatePlanHistoryFlow(history: Self.harrison(), hasTeslaPlan: true)
        #expect(flow.step == .currentKind)
        #expect(flow.preselectedKind == .timeOfUse)
        let fixedShape = RatePlanHistoryFlow(history: Self.harrison(teslaShape: .fixed), hasTeslaPlan: true)
        #expect(fixedShape.preselectedKind == .fixed)
    }

    @Test func asksPeakHoursOnlyForGroupedPlans() {
        var timeOfUse = RatePlanHistoryFlow(history: Self.harrison(), hasTeslaPlan: true)
        timeOfUse.chooseKind(.timeOfUse)
        #expect(timeOfUse.step == .peakHours(year: 2026))
        #expect(timeOfUse.pickedPlan?.name == Self.timeOfUseName)

        var fixed = RatePlanHistoryFlow(history: Self.harrison(), hasTeslaPlan: true)
        fixed.chooseKind(.fixed)
        #expect(fixed.step == .sinceStart)
        #expect(fixed.spans.first?.plan.name == Self.fixedName)
        #expect(fixed.spans.first?.windowLabel == nil)
    }

    @Test func skipsPlanListWhenTheKindHasOnePlan() {
        let current = [
            Self.timeOfUse(2026), Self.fixed(2026),
            Self.fixed(2026, name: "Residential Rg 3", isDefault: false)
        ]
        var flow = RatePlanHistoryFlow(history: Self.harrison(current: current), hasTeslaPlan: true)
        flow.chooseKind(.fixed)
        #expect(flow.step == .currentPlan(.fixed))
        #expect(flow.plans(for: flow.step).map(\.name) == [Self.fixedName, "Residential Rg 3"])
        flow.back()
        flow.chooseKind(.timeOfUse) // one Time of Use plan: straight to its hours
        #expect(flow.step == .peakHours(year: 2026))
        flow.back()
        flow.chooseKind(.fixed)
        flow.choosePlan(current[0])
        #expect(flow.step == .peakHours(year: 2026))
    }

    @Test func preselectsTheClosestPeakWindow() {
        var flow = RatePlanHistoryFlow(history: Self.harrison(), hasTeslaPlan: true)
        flow.chooseKind(.timeOfUse)
        #expect(flow.preselectedWindowLabel == "Rg 2 Option B 2026")
    }

    // MARK: - Walk-back

    @Test func asksOnceWhetherTheCurrentPlanRanSinceTheStart() {
        var flow = Self.onOptionB()
        #expect(flow.step == .sinceStart)
        #expect(flow.spans.map(\.from) == ["2023-11-14"])
        #expect(flow.spans[0].windowLabel == "Rg 2 Option B 2026")
        flow.answerSinceStart(true)
        #expect(flow.step == .review)
        #expect(flow.periods().map(\.withoutFixed) == [
            RatePlanHistoryPeriod(label: "Rg 2 Option B 2026", from: "2023-11-14", to: "2026-04-27")
        ])
    }

    @Test func noAsksWhenTheySwitchedThenThePlanBefore() {
        var flow = Self.onOptionB()
        flow.answerSinceStart(false)
        #expect(flow.step == .switchMonth)
        let months = flow.switchMonths()
        #expect(months.first == "2026-04")
        #expect(months.last == "2023-12")
        #expect(flow.defaultSwitchMonth() == "2026-01")
        flow.chooseSwitchMonth("2025-01")
        #expect(flow.step == .kind(year: 2024))
        #expect(flow.spans.map(\.from) == ["2025-01-01"])
        flow.chooseKind(.fixed)
        #expect(flow.step == .sinceStart)
        #expect(flow.currentPlan?.name == Self.fixedName)
        #expect(flow.spans.map(\.from) == ["2025-01-01", "2023-11-14"])
        #expect(flow.spans.map(\.endDate) == ["2026-04-27", "2024-12-31"])
        flow.answerSinceStart(true)
        #expect(flow.step == .review)
        #expect(flow.periods().map(\.withoutFixed) == [
            RatePlanHistoryPeriod(label: "Residential Rg 1 2024", from: "2023-11-14", to: "2024-12-31"),
            RatePlanHistoryPeriod(label: "Rg 2 Option B 2026", from: "2025-01-01", to: "2026-04-27")
        ])
    }

    @Test func anOlderSwitchEndsBeforeTheNewerPlan() {
        var flow = Self.onOptionB()
        flow.answerSinceStart(false)
        flow.chooseSwitchMonth("2025-01")
        flow.chooseKind(.fixed)
        flow.answerSinceStart(false)
        #expect(flow.switchMonths().first == "2024-12")
        #expect(flow.switchMonths().last == "2023-12")
        flow.chooseSwitchMonth("2024-06")
        #expect(flow.step == .kind(year: 2024))
        flow.chooseKind(.timeOfUse)
        #expect(flow.step == .peakHours(year: 2024))
        flow.choosePeakWindow(Self.windows(2024)[0])
        flow.answerSinceStart(true)
        #expect(flow.periods().map(\.withoutFixed) == [
            RatePlanHistoryPeriod(label: "Rg 2 Option A 2024", from: "2023-11-14", to: "2024-05-31"),
            RatePlanHistoryPeriod(label: "Residential Rg 1 2024", from: "2024-06-01", to: "2024-12-31"),
            RatePlanHistoryPeriod(label: "Rg 2 Option B 2026", from: "2025-01-01", to: "2026-04-27")
        ])
    }

    @Test func olderPlansFallBackToTodaysWhenTheYearHasNone() {
        let years = [Self.year(2025), Self.year(2024, []), Self.year(2023)]
        var flow = Self.onOptionB(Self.harrison(years: years))
        flow.answerSinceStart(false)
        flow.chooseSwitchMonth("2026-02")
        #expect(flow.step == .kind(year: 2026))
        #expect(flow.plans(for: flow.step).map(\.name) == [Self.timeOfUseName, Self.fixedName])
        flow.back()
        flow.chooseSwitchMonth("2025-01")
        #expect(flow.step == .kind(year: 2024))
        #expect(flow.plans(for: flow.step).map(\.name) == [Self.timeOfUseName, Self.fixedName])
    }

    @Test func openPeriodWithoutTesla() {
        let history = Self.harrison(fillThrough: nil, teslaShape: nil)
        var flow = RatePlanHistoryFlow(history: history, hasTeslaPlan: false, today: "2026-11-16")
        #expect(flow.preselectedKind == nil)
        flow.chooseKind(.fixed)
        #expect(flow.switchMonths().first == "2026-11")
        flow.answerSinceStart(true)
        #expect(flow.periods().map(\.withoutFixed) == [
            RatePlanHistoryPeriod(label: "Residential Rg 1 2026", from: "2023-11-14", to: nil)
        ])
    }

    // MARK: - Not sure

    @Test func stillNotSureWithTeslaPicksClosest() {
        var flow = RatePlanHistoryFlow(history: Self.harrison(), hasTeslaPlan: true)
        flow.stillNotSure()
        #expect(flow.step == .sinceStart)
        #expect(flow.spans.count == 1)
        #expect(flow.spans[0].plan.name == Self.timeOfUseName)
        #expect(flow.spans[0].windowLabel == "Rg 2 Option B 2026")
        #expect(flow.spans[0].assumed)
    }

    @Test func stillNotSureWithoutTeslaPicksDefault() {
        var flow = RatePlanHistoryFlow(history: Self.harrison(teslaShape: nil), hasTeslaPlan: false)
        flow.stillNotSure()
        #expect(flow.spans.first?.plan.name == Self.fixedName)
        #expect(flow.spans.first?.assumed == true)

        let current = [Self.timeOfUse(2026, closest: false), Self.fixed(2026)]
        let history = Self.harrison(current: current, teslaShape: nil)
        var onHours = RatePlanHistoryFlow(history: history, hasTeslaPlan: false)
        onHours.chooseKind(.timeOfUse)
        onHours.stillNotSure() // no closest window without Tesla: the first
        #expect(onHours.spans.first?.windowLabel == "Rg 2 Option A 2026")
        #expect(onHours.spans.first?.assumed == true)
    }

    @Test func stillNotSureSinceTheStartAssumesTheWholeStretch() {
        var flow = Self.onOptionB()
        flow.stillNotSure()
        #expect(flow.step == .review)
        #expect(flow.spans.map(\.assumed) == [true])
        #expect(flow.periods().map(\.withoutFixed) == [
            RatePlanHistoryPeriod(label: "Rg 2 Option B 2026", from: "2023-11-14", to: "2026-04-27")
        ])
    }

    @Test func backRestoresThePreviousStep() {
        var flow = Self.onOptionB()
        #expect(flow.step == .sinceStart)
        flow.back()
        #expect(flow.step == .peakHours(year: 2026))
        #expect(flow.spans.isEmpty)
        flow.back()
        #expect(flow.step == .currentKind)
        flow.back()
        #expect(flow.step == .currentKind)
    }

    private static func reviewedWithOneSwitch() -> RatePlanHistoryFlow {
        var flow = onOptionB()
        flow.answerSinceStart(false)
        flow.chooseSwitchMonth("2025-01")
        flow.chooseKind(.fixed)
        flow.answerSinceStart(true)
        return flow
    }

    @Test func changeOnTheOlderSpanAsksItsPlanAgain() {
        var flow = Self.reviewedWithOneSwitch()
        #expect(flow.step == .review)
        #expect(flow.spans.count == 2)
        flow.reopenSpan(at: 1)
        #expect(flow.step == .kind(year: 2024))
        #expect(flow.spans.count == 1)
    }

    @Test func changeOnTheCurrentSpanStartsOver() {
        var flow = Self.reviewedWithOneSwitch()
        flow.reopenSpan(at: 0)
        #expect(flow.spans.isEmpty)
        #expect(flow.step == .currentKind || flow.step == .peakHours(year: 2026))
        flow.reopenSpan(at: 0)
        #expect(flow.spans.isEmpty)
    }

    @Test func changeIgnoresAnIndexPastTheSpans() {
        var flow = Self.reviewedWithOneSwitch()
        let before = flow
        flow.reopenSpan(at: 2)
        #expect(flow == before)
    }
}
