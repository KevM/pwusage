import Foundation
@testable import PWUsage
import Testing

extension SolarHealthBaselineTests {
    private static func makeScoreBaseline(
        entries: [MonthEntry],
        planes: [SolarHealthPlane] = [.face(180, kw: 5)],
        now: Date
    ) throws -> (baseline: SolarHealthBaseline, years: [SolarHealthYear]) {
        let years = Self.years(entries)
        let manual = manualLayout(for: planes)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let baseline = try #require(SolarHealthBaseline(
            years: years,
            reference: reference,
            manual: manual,
            now: now))
        return (baseline, years)
    }

    @Test("Year one scores 100% with nothing compared")
    func yearOneScores100WithNothingCompared() throws {
        let entries = (4 ... 7).map { MonthEntry(2026, $0, 1.10, 10) }
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: entries,
            now: Self.date(2026, 8, 1))
        let score = baseline.score(of: years)

        #expect(score.site == 1.0)
        #expect(score.comparedMonths == 0)
    }

    @Test("A stable second year scores 100%")
    func stableSecondYearScores100() throws {
        let year1 = (4 ... 12).map { MonthEntry(2024, $0, 1.10, 10) }
            + (1 ... 3).map { MonthEntry(2025, $0, 1.10, 10) }
        let year2 = (4 ... 9).map { MonthEntry(2025, $0, 1.10, 10) }
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: year1 + year2,
            now: Self.date(2025, 10, 1))
        let score = baseline.score(of: years)

        #expect(abs(score.site - 1.0) < 1e-9)
        #expect(score.comparedMonths == 6)
    }

    @Test("Each month uses its most recent later factor against its own baseline")
    func eachMonthUsesMostRecentLaterFactor() throws {
        let year1 = (4 ... 12).map { MonthEntry(2024, $0, 1.10, 10) }
            + (1 ... 3).map { MonthEntry(2025, $0, 1.10, 10) }
        let year2 = (4 ... 9).map { MonthEntry(2025, $0, 1.10 * 0.98, 10) }
        let year3 = (4 ... 9).map { MonthEntry(2026, $0, 1.10 * 0.97, 10) }
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: year1 + year2 + year3,
            now: Self.date(2026, 10, 1))
        let score = baseline.score(of: years)

        #expect(abs(score.site - 0.97) < 1e-9)
    }

    @Test("Months are weighted by the current observation's clear days")
    func monthsWeightedByCurrentClearDays() throws {
        let entries: [MonthEntry] = [
            .init(2024, 5, 1.00, 20),
            .init(2024, 6, 1.00, 20),
            .init(2025, 5, 0.90, 10),
            .init(2025, 6, 1.00, 30)
        ]
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: entries,
            now: Self.date(2025, 7, 1))
        let score = baseline.score(of: years)

        #expect(abs(score.site - 0.975) < 1e-9)
    }

    @Test("A better year reads above 100%")
    func betterYearReadsAbove100() throws {
        let year1 = (4 ... 12).map { MonthEntry(2024, $0, 1.00, 10) }
            + (1 ... 3).map { MonthEntry(2025, $0, 1.00, 10) }
        let year2 = (4 ... 6).map { MonthEntry(2025, $0, 1.02, 10) }
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: year1 + year2,
            now: Self.date(2025, 7, 1))
        let score = baseline.score(of: years)

        #expect(abs(score.site - 1.02) < 1e-9)
    }

    @Test("Faces score against their own month baselines and skip unseparated months")
    func facesScoreAgainstOwnMonthBaselinesAndSkipUnseparated() throws {
        let twoFaces = [SolarHealthPlane.face(90, kw: 3), SolarHealthPlane.face(270, kw: 3)]
        let manual = manualLayout(for: twoFaces)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))

        let baseApril = SolarHealthMonth(
            month: 4,
            capacity: SolarHealthCapacity(
                site: 1.05,
                directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)],
                clearDays: 10))
        let baseMay = SolarHealthMonth(
            month: 5,
            capacity: SolarHealthCapacity(
                site: 1.05,
                directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)],
                clearDays: 10))
        let laterApril = SolarHealthMonth(
            month: 4,
            capacity: SolarHealthCapacity(
                site: 1.03,
                directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 0.96)],
                clearDays: 10))
        let laterMay = SolarHealthMonth(
            month: 5,
            capacity: SolarHealthCapacity(
                site: 1.03,
                directions: [.init(azimuth: 90, factor: 1.03)],
                clearDays: 10))
        let year2024 = SolarHealthYear(
            year: 2024, key: "2024", clearDays: 20, capacity: nil,
            months: [baseApril, baseMay], shade: [], dailyRatios: [])
        let year2025 = SolarHealthYear(
            year: 2025, key: "2025", clearDays: 20, capacity: nil,
            months: [laterApril, laterMay], shade: [], dailyRatios: [])

        let baseline = try #require(SolarHealthBaseline(
            years: [year2024, year2025],
            reference: reference,
            manual: manual,
            now: Self.date(2025, 6, 1)))
        let score = baseline.score(of: [year2024, year2025])

        #expect(score.directions == [.init(azimuth: 90, factor: 1.0), .init(azimuth: 270, factor: 0.96)])
    }

    @Test("Zero or negative factors are skipped instead of dividing by them")
    func zeroOrNegativeFactorsAreSkipped() throws {
        let year1 = (4 ... 12).map { month in
            MonthEntry(2024, month, month == 6 ? 0.0 : 1.0, 10)
        } + (1 ... 3).map { MonthEntry(2025, $0, 1.0, 10) }
        let later: [MonthEntry] = [
            .init(2025, 6, 0.9, 10),
            .init(2025, 7, -0.1, 10),
            .init(2025, 8, 0.95, 10)
        ]
        let (baseline, years) = try Self.makeScoreBaseline(
            entries: year1 + later,
            now: Self.date(2025, 9, 1))
        let score = baseline.score(of: years)

        #expect(score.site.isFinite)
        #expect(abs(score.site - 0.95) < 1e-9)
        #expect(score.comparedMonths == 1)
    }
}
