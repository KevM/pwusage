import Foundation
@testable import PWUsage
import Testing

/// Confidence in the matched-month aging trend: how much evidence a rate needs before it is
/// called initial or confident and can raise the aging finding.
@Suite("Solar health aging confidence")
struct SolarHealthClassifierAgingTests {
    private static let south = [SolarHealthPlane.face(180, tilt: 25, kw: 5)]

    /// A result whose months hold `factor(year, month)` for each listed month, ten clear days each.
    private static func analysis(
        months: [(year: Int, month: Int)], factor: (Int, Int) -> Double
    ) throws -> SolarHealthClassifier.ChangeAnalysis {
        let manual = manualLayout(for: south)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let years = Dictionary(grouping: months, by: \.year).keys.sorted().map { year in
            let yearMonths = months.filter { $0.year == year }.map { entry in
                SolarHealthMonth(
                    month: entry.month,
                    capacity: SolarHealthCapacity(
                        site: factor(year, entry.month), directions: [], clearDays: 10))
            }
            return SolarHealthYear(
                year: year, key: "k-\(year)", clearDays: yearMonths.count * 10,
                capacity: SolarHealthCapacity(
                    site: yearMonths.first?.capacity.site ?? 1, directions: [], clearDays: yearMonths.count * 10),
                months: yearMonths, shade: [], dailyRatios: [])
        }
        let result = SolarHealthResult(reference: reference, years: years, referenceScale: 1, recomputedYears: [])
        return SolarHealthClassifier.analyzeChangeOverTime(from: result, manual: manual, now: .now)
    }

    @Test("Two matched winters two years apart report a rate but no confidence or finding")
    func sparseOverlapIsNotConfident() throws {
        let months = [(2023, 12), (2024, 1), (2024, 2), (2026, 1), (2026, 2)].map { (year: $0.0, month: $0.1) }
        let analysis = try Self.analysis(months: months) { year, _ in year == 2026 ? 0.97 : 1 }

        let rate = try #require(analysis.change.agingPercentPerYear)
        #expect(abs(rate - -1.5) < 0.01)
        #expect(analysis.change.agingConfidence == nil)
        #expect(analysis.finding == nil)
    }

    @Test("Four pairs over two calendar months across two years are initial, not confident")
    func fewMonthsAreInitial() throws {
        let months = (2023 ... 2025).flatMap { year in [5, 6].map { (year: year, month: $0) } }
            + [(year: 2026, month: 1)]
        let analysis = try Self.analysis(months: months) { year, _ in 1 - 0.015 * Double(year - 2023) }

        #expect(analysis.change.agingConfidence == .initial)
        #expect(analysis.finding?.confidence == .initial)
    }

    @Test("Six pairs over three calendar months across two years are confident")
    func enoughPairsAreConfident() throws {
        let months = (2023 ... 2025).flatMap { year in [5, 6, 7].map { (year: year, month: $0) } }
        let analysis = try Self.analysis(months: months) { year, _ in 1 - 0.015 * Double(year - 2023) }

        #expect(analysis.change.agingConfidence == .confident)
        let finding = try #require(analysis.finding)
        #expect(finding.confidence == .confident)
        #expect(finding.meetsMinimumEvidence)
    }

    @Test("A single matched pair gives no confidence even over thirteen months")
    func onePairIsNotInitial() throws {
        let months = [(year: 2024, month: 6), (year: 2025, month: 6), (year: 2025, month: 7)]
        let analysis = try Self.analysis(months: months) { year, _ in year == 2025 ? 0.97 : 1 }

        #expect(analysis.change.agingConfidence == nil)
        #expect(analysis.finding == nil)
    }
}
