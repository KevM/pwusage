import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health baseline")
struct SolarHealthBaselineTests {
    struct MonthEntry {
        let year: Int
        let month: Int
        let factor: Double
        let clearDays: Int

        init(_ year: Int, _ month: Int, _ factor: Double, _ clearDays: Int) {
            self.year = year
            self.month = month
            self.factor = factor
            self.clearDays = clearDays
        }
    }

    static func years(_ entries: [MonthEntry]) -> [SolarHealthYear] {
        Dictionary(grouping: entries, by: \.year)
            .sorted { $0.key < $1.key }
            .map { year, group in
                let months = group
                    .sorted { $0.month < $1.month }
                    .map { entry in
                        SolarHealthMonth(
                            month: entry.month,
                            capacity: SolarHealthCapacity(
                                site: entry.factor,
                                directions: [],
                                clearDays: entry.clearDays))
                    }
                return SolarHealthYear(
                    year: year,
                    key: "test-\(year)",
                    clearDays: group.reduce(0) { $0 + $1.clearDays },
                    capacity: nil,
                    months: months,
                    shade: [],
                    dailyRatios: [])
            }
    }

    static func date(_ year: Int, _ month: Int, _ day: Int = 1) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        return Calendar(identifier: .gregorian).date(from: components) ?? Date(timeIntervalSince1970: 0)
    }

    private static func makeBaseline(
        entries: [MonthEntry],
        planes: [SolarHealthPlane] = [.face(180, kw: 5)],
        installDates: [Date?]? = nil,
        now: Date
    ) throws -> SolarHealthBaseline {
        let manual = manualLayout(for: planes, installDates: installDates)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        return try #require(SolarHealthBaseline(
            years: Self.years(entries),
            reference: reference,
            manual: manual,
            now: now))
    }

    @Test("Window starts at the first month with a factor and freezes after 12 months over 4 seasons")
    func windowStartsAndFreezes() throws {
        let entries: [MonthEntry] = [
            .init(2024, 4, 1.00, 20),
            .init(2024, 7, 1.20, 4),
            .init(2024, 10, 1.00, 20),
            .init(2025, 1, 1.00, 4)
        ]
        let baseline = try Self.makeBaseline(entries: entries, now: Self.date(2025, 6, 15))

        #expect(baseline.windowStart == SolarHealthMonthStamp(year: 2024, month: 4))
        #expect(!baseline.isProvisional)
        #expect(baseline.seasonsCovered == 4)
        #expect(abs(baseline.siteFactor - 48.8 / 48) < 1e-9)
        #expect(baseline.clearDays == 48)
        #expect(baseline.label == .asNew)
        #expect(baseline.relativeUnit == "of new")
    }

    @Test("Provisional while the window is open, with months weighted equally")
    func provisionalWhileWindowOpen() throws {
        let entries: [MonthEntry] = [
            .init(2026, 5, 1.00, 20),
            .init(2026, 6, 1.20, 4)
        ]
        let baseline = try Self.makeBaseline(entries: entries, now: Self.date(2026, 7, 10))

        #expect(baseline.isProvisional)
        #expect(abs(baseline.siteFactor - 1.10) < 1e-9)
        #expect(baseline.seasonsCovered == 2)
        #expect(baseline.clearDays == 24)
    }

    @Test("A closed window with fewer than three seasons stays provisional until later years fill them")
    func closedWindowNeedsThreeSeasons() throws {
        let baseEntries: [MonthEntry] = [
            .init(2024, 6, 1.0, 10),
            .init(2024, 7, 1.0, 10),
            .init(2024, 8, 1.0, 10)
        ]
        let oneSeason = try Self.makeBaseline(entries: baseEntries, now: Self.date(2025, 9, 1))
        #expect(oneSeason.isProvisional)
        #expect(oneSeason.seasonsCovered == 1)

        let twoSeasons = try Self.makeBaseline(
            entries: baseEntries + [.init(2024, 12, 1.0, 10)],
            now: Self.date(2025, 9, 1))
        #expect(twoSeasons.isProvisional)
        #expect(twoSeasons.seasonsCovered == 2)

        let threeSeasons = try Self.makeBaseline(
            entries: baseEntries + [.init(2024, 12, 1.0, 10), .init(2025, 3, 1.0, 10)],
            now: Self.date(2025, 9, 1))
        #expect(!threeSeasons.isProvisional)
        #expect(threeSeasons.seasonsCovered == 3)
    }

    @Test("A calendar month's baseline is its first factor on or after the window start")
    func calendarMonthBaselineIsFirstOnOrAfterWindowStart() throws {
        let windowEntries = (4 ... 11).map { MonthEntry(2024, $0, 1.10, 10) }
        let entries = windowEntries + [.init(2025, 12, 0.98, 6)]
        let baseline = try Self.makeBaseline(entries: entries, now: Self.date(2026, 1, 15))

        #expect(baseline.months[12]?.stamp == SolarHealthMonthStamp(year: 2025, month: 12))
        #expect(baseline.months[12]?.capacity.site == 0.98)
        #expect(baseline.monthFactor(1) == baseline.siteFactor)
        #expect(abs(baseline.siteFactor - 1.10) < 1e-9)
    }

    @Test("The newest install date restarts the window and earlier months are not baselines")
    func newestInstallDateRestartsWindow() throws {
        var entries: [MonthEntry] = []
        for year in 2022 ... 2025 {
            for month in 1 ... 12 {
                if year == 2025, month > 2 { continue }
                if year == 2024 || year == 2025, month == 5 { continue }
                let factor = (year == 2022 || year == 2023) && month == 5 ? 0.90 : 1.0
                entries.append(.init(year, month, factor, 10))
            }
        }
        let baseline = try Self.makeBaseline(
            entries: entries,
            planes: [.face(180, kw: 3), .face(180, kw: 3)],
            installDates: [nil, Self.date(2024, 3, 1)],
            now: Self.date(2025, 6, 15))

        #expect(baseline.windowStart == SolarHealthMonthStamp(year: 2024, month: 3))
        #expect(baseline.months[5] == nil)
        #expect(baseline.restartYear == 2024)
        #expect(baseline.isBeforeWindow(SolarHealthMonthStamp(year: 2024, month: 2)))
        #expect(!baseline.isBeforeWindow(SolarHealthMonthStamp(year: 2024, month: 3)))
        #expect(baseline.isBeforeWindow(year: 2023))
    }

    @Test("History starting more than 13 months after install is labelled by its first year")
    func delayedHistoryLabelledByFirstYear() throws {
        let entries = (1 ... 12).map { MonthEntry(2022, $0, 1.0, 10) }
        let baseline = try Self.makeBaseline(
            entries: entries,
            installDates: [Self.date(2019, 6, 1)],
            now: Self.date(2023, 3, 1))

        #expect(baseline.label == .firstYear(2022))
        #expect(baseline.relativeUnit == "of 2022")
        #expect(baseline.restartYear == nil)

        let recentBaseline = try Self.makeBaseline(
            entries: [.init(2024, 4, 1.0, 10)],
            installDates: [Self.date(2024, 3, 1)],
            now: Self.date(2024, 5, 1))
        #expect(recentBaseline.label == .asNew)
    }

    @Test("No baseline when every factor predates the newest install")
    func nilWhenAllFactorsPredateNewestInstall() throws {
        let entries = (4 ... 12).map { MonthEntry(2024, $0, 1.0, 10) }
            + (1 ... 11).map { MonthEntry(2025, $0, 1.0, 10) }
        let manual = manualLayout(for: [.face(180, kw: 5)], installDates: [Self.date(2026, 1, 1)])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))

        let baseline = SolarHealthBaseline(
            years: Self.years(entries),
            reference: reference,
            manual: manual,
            now: Self.date(2026, 2, 1))
        #expect(baseline == nil)
    }

    @Test("Faces get a site-wide baseline only from months where the fit separated them")
    func facesGetBaselineOnlyFromSeparatedMonths() throws {
        let twoFaces = [SolarHealthPlane.face(90, kw: 3), SolarHealthPlane.face(270, kw: 3)]
        let manual = manualLayout(for: twoFaces)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))

        let april = SolarHealthMonth(
            month: 4,
            capacity: SolarHealthCapacity(
                site: 1.05,
                directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)],
                clearDays: 10))
        let may = SolarHealthMonth(
            month: 5,
            capacity: SolarHealthCapacity(
                site: 1.05,
                directions: [.init(azimuth: 90, factor: 1.05)],
                clearDays: 10))
        let rest2024 = (6 ... 12).map {
            SolarHealthMonth(month: $0, capacity: SolarHealthCapacity(site: 1.05, directions: [], clearDays: 10))
        }
        let early2025 = (1 ... 3).map {
            SolarHealthMonth(month: $0, capacity: SolarHealthCapacity(site: 1.05, directions: [], clearDays: 10))
        }
        let year2024 = SolarHealthYear(
            year: 2024, key: "2024", clearDays: 90, capacity: nil,
            months: [april, may] + rest2024, shade: [], dailyRatios: [])
        let year2025 = SolarHealthYear(
            year: 2025, key: "2025", clearDays: 30, capacity: nil,
            months: early2025, shade: [], dailyRatios: [])

        let baseline = try #require(SolarHealthBaseline(
            years: [year2024, year2025],
            reference: reference,
            manual: manual,
            now: Self.date(2025, 4, 15)))

        #expect(baseline.directionFactors == [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)])
        #expect(baseline.directionFactor(azimuth: 270) == 1.00)
        #expect(baseline.directionFactor(azimuth: 180) == baseline.siteFactor)
    }
}
