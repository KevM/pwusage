@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Rate Plans scroll target")
struct RatePlansScrollTargetTests {
    private static func period(_ id: Int, _ from: String, _ to: String?, today: Bool = false) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: id, tariffId: id, name: "P\(id)", version: 1, source: .manual, effectiveFrom: from,
            effectiveTo: to, isCurrentToday: today, updatedBy: nil, seasons: []
        )
    }

    private static func timeline(
        periods: [TariffPeriodDTO],
        references: [TariffPeriodDTO]
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2, siteId: "s", timezone: "UTC", currency: "USD", periods: periods,
            referencePeriods: references, reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil, activeManualUpdatedAt: nil,
                differsFromActiveManual: false, syncAvailable: false, syncUnavailableReason: nil, lastSync: nil
            )
        )
    }

    private static let plans = [
        period(1, "2024-01-01", "2024-12-31"),
        period(2, "2025-01-01", "2025-12-31"),
        period(3, "2026-01-01", nil, today: true)
    ]

    @Test func todayIsTheCurrentPlan() {
        let data = Self.timeline(periods: Self.plans, references: [])
        #expect(RatePlansScrollTarget.today.periodID(in: data) == 3)
        #expect(RatePlansScrollTarget.today.periodID(in: Self.timeline(periods: [], references: [])) == nil)
    }

    @Test func firstUncoveredIsTheOldestPlanWithAGap() {
        let covered = [
            Self.period(10, "2024-01-01", "2024-12-31"),
            Self.period(11, "2025-01-01", "2025-06-30")
        ]
        let data = Self.timeline(periods: Self.plans, references: covered)
        // Plan 2 is only covered until June; plan 3 has nothing.
        #expect(RatePlansScrollTarget.firstUncovered.periodID(in: data) == 2)
    }

    @Test func firstUncoveredIsNilWhenEverythingIsCovered() {
        let all = [Self.period(10, "2024-01-01", nil)]
        let data = Self.timeline(periods: Self.plans, references: all)
        #expect(RatePlansScrollTarget.firstUncovered.periodID(in: data) == nil)
    }
}
