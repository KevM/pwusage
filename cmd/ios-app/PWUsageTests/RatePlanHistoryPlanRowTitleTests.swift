import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

/// We Energies 2024: Option A (7 AM – 7 PM) is priced apart from B–D, so the server lists two
/// Time of Use rows with one name.
@Suite("Rate plan history plan row titles")
struct RatePlanHistoryPlanRowTitleTests {
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

    @Test func rowsSharingANameShowTheirPeakHours() {
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionA, among: Self.split)
            == "Residential Time-of-Use Rg 2 · Peak 7 AM – 7 PM")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionsBToD, among: Self.split)
            == "Residential Time-of-Use Rg 2 · Peak 8 AM – 10 PM")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.fixed, among: Self.split) == "Residential Rg 1")
        #expect(RatePlanHistoryPresentation.planRowTitle(Self.optionA, among: [Self.optionA, Self.fixed])
            == "Residential Time-of-Use Rg 2")
    }
}
