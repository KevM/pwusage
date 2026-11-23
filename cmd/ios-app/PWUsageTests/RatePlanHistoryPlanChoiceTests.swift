import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

/// We Energies 2024: Option A (7 AM – 7 PM) is priced apart from B–D, so the server lists two
/// Time of Use rows with one name.
@Suite("Rate plan history plan choice")
struct RatePlanHistoryPlanChoiceTests {
    private static let rg2 = "Residential Time-of-Use (Single-Phase) Rg 2"

    private static func window(_ option: String, _ from: Int) -> RatePlanPeakWindowDTO {
        RatePlanPeakWindowDTO(label: "Option \(option) 2024", fromHour: from, toHour: from + 12)
    }

    private static let optionA = RatePlanHistoryPlanDTO(
        name: rg2, startDate: "2024-06-01", kind: .timeOfUse, isDefault: false, closest: false,
        lowRate: 0.09, highRate: 0.25, peakWindows: [window("A", 7)], closestWindow: nil, fixedLabel: nil
    )
    private static let optionsBToD = RatePlanHistoryPlanDTO(
        name: rg2, startDate: "2024-06-01", kind: .timeOfUse, isDefault: false, closest: true,
        lowRate: 0.1, highRate: 0.27, peakWindows: [window("B", 8), window("C", 9), window("D", 10)],
        closestWindow: "Option B 2024", fixedLabel: nil
    )
    private static let fixed = RatePlanHistoryPlanDTO(
        name: "Residential (Single-Phase) Rg 1", startDate: "2024-06-01", kind: .fixed, isDefault: true,
        closest: false, lowRate: 0.18, highRate: 0.18, peakWindows: [], closestWindow: nil, fixedLabel: "Rg 1 2024"
    )
    private static let split = [optionsBToD, optionA, fixed]

    private static func history(current: [RatePlanHistoryPlanDTO] = split) -> RatePlanHistoryDTO {
        RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2026-04-27", teslaShape: .timeOfUse,
            current: current,
            years: [RatePlanHistoryYearDTO(year: 2025, askDate: "2025-07-01", plans: split)]
        )
    }

    @Test func plansWithOneNameHaveDistinctIDs() {
        #expect(Set(Self.split.map(\.id)).count == Self.split.count)
        #expect(Self.optionA.id == "Option A 2024")
        #expect(Self.fixed.id == "Rg 1 2024")
    }

    @Test func rowsSharingANameShowTheirPeakHours() {
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionA, among: Self.split)
            == "Residential Time-of-Use Rg 2 · Peak 7 AM – 7 PM")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionsBToD, among: Self.split)
            == "Residential Time-of-Use Rg 2 · Peak 8 AM – 10 PM")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.fixed, among: Self.split) == "Residential Rg 1")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionA, among: [Self.optionA, Self.fixed])
            == "Residential Time-of-Use Rg 2")
    }

    @Test func choosingTheSecondRowOfOneNameKeepsIt() {
        var flow = RatePlanHistoryFlow(history: Self.history(), hasTeslaPlan: true)
        flow.chooseKind(.timeOfUse)
        #expect(flow.step == .currentPlan(.timeOfUse))
        flow.choosePlan(Self.optionA)
        #expect(flow.spans.first?.windowLabel == "Option A 2024")
        #expect(flow.step == .sinceStart)
    }

    @Test func notSureOnThePlanStepKeepsTheChosenKind() {
        // The closest plan is Time of Use; the owner said Fixed and has two Fixed plans to choose from.
        let other = RatePlanHistoryPlanDTO(
            name: "Residential Saver Rg 3", startDate: "2024-06-01", kind: .fixed, isDefault: false, closest: false,
            lowRate: 0.2, highRate: 0.2, peakWindows: [], closestWindow: nil, fixedLabel: "Rg 3 2024"
        )
        var flow = RatePlanHistoryFlow(history: Self.history(current: Self.split + [other]), hasTeslaPlan: true)
        flow.chooseKind(.fixed)
        #expect(flow.step == .currentPlan(.fixed))
        flow.stillNotSure()
        #expect(flow.spans.first?.plan.kind == .fixed)
        #expect(flow.spans.first?.assumed == true)
    }

    @Test func periodsKeepAPlanThatReturnsAfterAnotherApart() {
        var flow = RatePlanHistoryFlow(history: Self.walkThree(), hasTeslaPlan: true)
        flow.chooseKind(.fixed)
        flow.answerSinceStart(false)
        flow.chooseSwitchMonth("2025-06")
        flow.chooseKind(.timeOfUse)
        flow.choosePlan(Self.optionA)
        flow.answerSinceStart(false)
        flow.chooseSwitchMonth("2024-03")
        flow.chooseKind(.fixed)
        flow.answerSinceStart(true)
        #expect(flow.step == .review)
        #expect(flow.periods().map(\.label) == ["Rg 1 2024", "Option A 2024", "Rg 1 2024"])
    }

    @Test func switchMonthsStopAtTheEndOfTheWindow() {
        // Tesla from January 1: the plan before it can't have started after December.
        let history = RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2025-12-31", teslaShape: .timeOfUse,
            current: [Self.fixed],
            years: [RatePlanHistoryYearDTO(year: 2025, askDate: "2025-07-01", plans: Self.split)]
        )
        var flow = RatePlanHistoryFlow(history: history, hasTeslaPlan: true)
        flow.chooseKind(.fixed)
        flow.answerSinceStart(false)
        #expect(flow.switchMonths().first == "2025-12")
        #expect(flow.reviewSpans.map(\.index) == [0])
    }

    private static func walkThree() -> RatePlanHistoryDTO {
        RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2026-04-27", teslaShape: .timeOfUse,
            current: [fixed],
            years: [
                RatePlanHistoryYearDTO(year: 2025, askDate: "2025-07-01", plans: split),
                RatePlanHistoryYearDTO(year: 2024, askDate: "2024-07-01", plans: split)
            ]
        )
    }
}
