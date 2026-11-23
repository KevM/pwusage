import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Rate plan history fixed comparisons")
struct RatePlanHistoryFixedComparisonTests {
    private static func reference(
        _ id: Int, from: String, to: String?, name: String = "Stored fixed", source: TariffSource = .estimated
    ) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: id, tariffId: id * 10, name: name, version: 1, source: source,
            effectiveFrom: from, effectiveTo: to, isCurrentToday: false, updatedBy: nil, seasons: []
        )
    }

    /// A time-of-use plan on Option B, 2023-11-14 through 2026-04-27, answered "since the start".
    private static func reviewed(
        references: [TariffPeriodDTO],
        history: RatePlanHistoryDTO = RatePlanHistoryFlowTests.harrison()
    ) -> RatePlanHistoryFlow {
        var flow = RatePlanHistoryFlow(history: history, hasTeslaPlan: true, referencePeriods: references)
        flow.chooseKind(.timeOfUse)
        flow.choosePeakWindow(RatePlanHistoryFlowTests.optionB(2026))
        flow.answerSinceStart(true)
        return flow
    }

    // MARK: - Encoding

    private func json(_ period: RatePlanHistoryPeriod) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try #require(String(data: encoder.encode(period), encoding: .utf8))
    }

    @Test func nilFixedOmitsTheKey() throws {
        let text = try json(RatePlanHistoryPeriod(label: "L", from: "2024-01-01", to: nil))
        #expect(text == #"{"from":"2024-01-01","label":"L","to":null}"#)
    }

    @Test func publicChoiceEncodesOnlyItsLabel() throws {
        let period = RatePlanHistoryPeriod(
            label: "L", from: "2024-01-01", to: "2024-12-31",
            fixed: .publicPlan(label: "FIX", name: "Residential Rg 1", buyRate: 0.18)
        )
        #expect(try json(period) == #"{"fixed":{"label":"FIX"},"from":"2024-01-01","label":"L","to":"2024-12-31"}"#)
    }

    @Test func manualChoiceEncodesNameAndRates() throws {
        let period = RatePlanHistoryPeriod(
            label: "L", from: "2024-01-01", to: nil,
            fixed: .manual(name: "My rate", buyRate: 0.2, sellRate: 0.05)
        )
        #expect(try json(period)
            == #"{"fixed":{"buyRate":0.2,"name":"My rate","sellRate":0.05},"from":"2024-01-01","label":"L","to":null}"#)
    }

    // MARK: - Prefill and fallback

    @Test func spanCoveredByStoredReferencesStagesNothing() {
        let refs = [Self.reference(1, from: "2023-01-01", to: nil)]
        let flow = Self.reviewed(references: refs)
        #expect(flow.stagedFixed(forSpanAt: 0) == nil)
        #expect(flow.periods().map(\.fixed) == [nil])
        let rows = flow.comparisonRows(forSpanAt: 0)
        #expect(rows.count == 1)
        #expect(rows.first?.reference == refs[0])
        #expect(rows.first?.from == "2023-11-14")
        #expect(rows.first?.to == "2026-04-27")
    }

    @Test func partlyCoveredSpanKeepsItsGapRowsAndStagesNothing() {
        let flow = Self.reviewed(references: [Self.reference(1, from: "2025-01-01", to: nil)])
        #expect(flow.stagedFixed(forSpanAt: 0) == nil)
        let rows = flow.comparisonRows(forSpanAt: 0)
        #expect(rows.map { $0.reference == nil } == [true, false])
        #expect(flow.periods().map(\.fixed) == [nil])
    }

    @Test func uncoveredSpanFallsBackToTheStartYearsDefaultFixedPlan() {
        let flow = Self.reviewed(references: [])
        let expected = FixedComparisonChoice.publicPlan(
            label: "Residential Rg 1 2023", name: "Residential Rg 1", buyRate: 0.18
        )
        #expect(flow.stagedFixed(forSpanAt: 0) == expected)
        #expect(flow.periods().map(\.fixed) == [expected])
        let rows = flow.comparisonRows(forSpanAt: 0)
        #expect(rows.count == 1)
        #expect(rows.first?.reference?.name == "Residential Rg 1")
        #expect(rows.first?.reference?.source == .manual)
        #expect(rows.first?.from == "2023-11-14")
        #expect(rows.first?.to == "2026-04-27")
    }

    @Test func fallbackPrefersTheDefaultElseTheFirstFixedPlan() {
        let plans = [
            RatePlanHistoryFlowTests.timeOfUse(2023),
            RatePlanHistoryFlowTests.fixed(2023, name: "First", isDefault: false),
            RatePlanHistoryFlowTests.fixed(2023, name: "Second", isDefault: true)
        ]
        let years = [RatePlanHistoryFlowTests.year(2023, plans)]
        let defaultFlow = Self.reviewed(references: [], history: RatePlanHistoryFlowTests.harrison(years: years))
        #expect(defaultFlow.stagedFixed(forSpanAt: 0)?.label == "Second 2023")

        let noDefault = [
            RatePlanHistoryFlowTests.timeOfUse(2023),
            RatePlanHistoryFlowTests.fixed(2023, name: "First", isDefault: false)
        ]
        let history = RatePlanHistoryFlowTests.harrison(years: [RatePlanHistoryFlowTests.year(2023, noDefault)])
        #expect(Self.reviewed(references: [], history: history).stagedFixed(forSpanAt: 0)?.label == "First 2023")
    }

    @Test func noFixedPlanForTheYearStagesNothing() {
        let years = [RatePlanHistoryFlowTests.year(2023, [RatePlanHistoryFlowTests.timeOfUse(2023)])]
        let flow = Self.reviewed(references: [], history: RatePlanHistoryFlowTests.harrison(years: years))
        #expect(flow.stagedFixed(forSpanAt: 0) == nil)
        #expect(flow.periods().map(\.fixed) == [nil])
        #expect(flow.comparisonRows(forSpanAt: 0).map { $0.reference == nil } == [true])
    }

    @Test func aSpanThatIsAFixedPlanStagesItselfEvenWhenReferencesCoverIt() {
        var flow = RatePlanHistoryFlow(
            history: RatePlanHistoryFlowTests.harrison(), hasTeslaPlan: true,
            referencePeriods: [Self.reference(1, from: "2023-01-01", to: nil)]
        )
        flow.chooseKind(.fixed)
        flow.answerSinceStart(true)
        let expected = FixedComparisonChoice.publicPlan(
            label: "Residential Rg 1 2026", name: "Residential Rg 1", buyRate: 0.18
        )
        #expect(flow.stagedFixed(forSpanAt: 0) == expected)
        #expect(flow.periods().map(\.fixed) == [expected])
        #expect(flow.comparisonRows(forSpanAt: 0).count == 1)
    }

    // MARK: - Change

    @Test func changeReplacesAllRowsForSpan() {
        let refs = [
            Self.reference(1, from: "2023-01-01", to: "2024-12-31"),
            Self.reference(2, from: "2025-01-01", to: nil)
        ]
        var flow = Self.reviewed(references: refs)
        #expect(flow.comparisonRows(forSpanAt: 0).count == 2)
        let choice = FixedComparisonChoice.manual(name: "My rate", buyRate: 0.22, sellRate: 0.04)
        flow.chooseFixed(choice, forSpanAt: 0)
        #expect(flow.stagedFixed(forSpanAt: 0) == choice)
        #expect(flow.periods().map(\.fixed) == [choice])
        let rows = flow.comparisonRows(forSpanAt: 0)
        #expect(rows.count == 1)
        #expect(rows.first?.from == "2023-11-14")
        #expect(rows.first?.to == "2026-04-27")
        #expect(rows.first?.reference?.name == "My rate")
        #expect(rows.first?.reference?.seasons.first?.weekdayPeriods.first?.buyRate == 0.22)
    }

    @Test func backUndoesAChangedChoice() {
        var flow = Self.reviewed(references: [Self.reference(1, from: "2023-01-01", to: nil)])
        flow.chooseFixed(.manual(name: "My rate", buyRate: 0.22, sellRate: 0), forSpanAt: 0)
        flow.back()
        #expect(flow.stagedFixed(forSpanAt: 0) == nil)
        #expect(flow.step == .review)
    }

    @Test func chooseFixedIgnoresAnUnknownSpan() {
        var flow = Self.reviewed(references: [])
        let before = flow
        flow.chooseFixed(.manual(name: "x", buyRate: 1, sellRate: 0), forSpanAt: 5)
        #expect(flow == before)
        #expect(flow.stagedFixed(forSpanAt: 5) == nil)
        #expect(flow.comparisonRows(forSpanAt: 5).isEmpty)
    }
}

extension RatePlanHistoryPeriod {
    /// The period's dates and label only, for tests that predate the staged fixed comparison.
    var withoutFixed: RatePlanHistoryPeriod {
        RatePlanHistoryPeriod(label: label, from: from, to: endDate)
    }
}
