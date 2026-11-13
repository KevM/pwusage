import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health score presentation")
struct SolarHealthScorePresentationTests {
    private static let enUS = Locale(identifier: "en_US")

    private static func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        return Calendar.current.date(from: components) ?? Date(timeIntervalSince1970: 0)
    }

    private static func makeMonth(
        _ month: Int,
        factor: Double,
        clearDays: Int = 10,
        directions: [SolarHealthCapacity.Direction]? = nil
    ) -> SolarHealthMonth {
        let resolvedDirections = directions ?? [.init(azimuth: 180, factor: factor)]
        return SolarHealthMonth(
            month: month,
            capacity: SolarHealthCapacity(
                site: factor,
                directions: resolvedDirections,
                clearDays: clearDays))
    }

    private static func makeYear(
        _ year: Int,
        months: [SolarHealthMonth],
        siteFactor: Double = 1.0
    ) -> SolarHealthYear {
        let totalDays = months.reduce(0) { $0 + $1.capacity.clearDays }
        return SolarHealthYear(
            year: year,
            key: "k-\(year)",
            clearDays: totalDays,
            capacity: SolarHealthCapacity(
                site: siteFactor,
                directions: [.init(azimuth: 180, factor: siteFactor)],
                clearDays: totalDays),
            months: months,
            shade: [],
            dailyRatios: [])
    }

    private static func classifyScore(
        years: [SolarHealthYear],
        manual: ManualSolarLayout = manualLayout(for: [.face(180, tilt: 25, kw: 5)]),
        now: Date
    ) throws -> SolarHealthReport.HealthScore {
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let result = SolarHealthResult(
            reference: reference,
            years: years,
            referenceScale: 1.0,
            recomputedYears: [years.last?.year ?? 2025])
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)
        return try #require(report.healthScore)
    }

    @Test("Frozen score reads as % of new with rated efficiency and the healthy range")
    func frozenScoreReadsAsPercentOfNew() throws {
        let factor = 0.94 / SolarLayoutDetector.derate
        let twoFaces = [
            SolarHealthCapacity.Direction(azimuth: 90, factor: factor),
            SolarHealthCapacity.Direction(azimuth: 270, factor: factor)
        ]
        let comparedFaces = [
            SolarHealthCapacity.Direction(azimuth: 90, factor: factor * 1.00),
            SolarHealthCapacity.Direction(azimuth: 270, factor: factor * 0.96)
        ]
        let y2024 = Self.makeYear(
            2024,
            months: (4 ... 12).map { Self.makeMonth($0, factor: factor, directions: twoFaces) })
        let y2025 = Self.makeYear(
            2025,
            months: (1 ... 3).map { Self.makeMonth($0, factor: factor, directions: twoFaces) }
                + [Self.makeMonth(4, factor: factor * 0.98, directions: comparedFaces)])
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(faces: [
                ManualSolarFace(panelCount: 10, panelWatts: 500, azimuthDegrees: 90, tiltDegrees: 25),
                ManualSolarFace(panelCount: 10, panelWatts: 500, azimuthDegrees: 270, tiltDegrees: 25)
            ])
        ])
        let score = try Self.classifyScore(
            years: [y2024, y2025],
            manual: manual,
            now: Self.date(2025, 6, 1))
        let presentation = SolarHealthScorePresentation(score: score, locale: Self.enUS)

        #expect(presentation.headline == "98% of new")
        #expect(presentation.headlineDetail == nil)
        #expect(presentation.band == "(±8%)")
        #expect(presentation.efficiencyLabel == "When new")
        #expect(presentation.efficiencyValue == "94% of its 10.0 kW rating · healthy range 82–98%")
        #expect(presentation.directionRows.map(\.value) == ["100% of new", "96% of new"])
        #expect(presentation.panelCheckPrompt == nil)
        #expect(presentation.restartNote == nil)
    }

    @Test("Provisional score is learning, with seasons and clear days, and never emphasized")
    func provisionalScoreIsLearning() throws {
        let y2026 = Self.makeYear(
            2026,
            months: [
                Self.makeMonth(5, factor: 0.70, clearDays: 15),
                Self.makeMonth(7, factor: 0.70, clearDays: 16)
            ])
        let score = try Self.classifyScore(
            years: [y2026],
            now: Self.date(2026, 8, 1))
        let presentation = SolarHealthScorePresentation(score: score, locale: Self.enUS)

        #expect(presentation.headline == "Learning your system")
        #expect(presentation.headlineDetail == "2 of 4 seasons · 31 clear days")
        #expect(presentation.efficiencyLabel == "When new (so far)")
        #expect(!presentation.isEmphasized)
    }

    @Test("Provisional score with compared months shows the figure with the learning detail")
    func provisionalScoreWithComparedMonths() throws {
        let y2025 = Self.makeYear(
            2025,
            months: [
                Self.makeMonth(5, factor: 1.00, clearDays: 15),
                Self.makeMonth(7, factor: 1.00, clearDays: 16)
            ])
        let y2026 = Self.makeYear(
            2026,
            months: [Self.makeMonth(5, factor: 0.97, clearDays: 10)])
        let score = try Self.classifyScore(
            years: [y2025, y2026],
            now: Self.date(2026, 5, 20))
        let presentation = SolarHealthScorePresentation(score: score, locale: Self.enUS)

        #expect(presentation.headline == "97% of new")
        #expect(presentation.headlineDetail == "Learning your system · 2 of 4 seasons · 31 clear days")
    }

    @Test("Older systems read against their first year and note that older panels sit lower")
    func olderSystemReadsAgainstFirstYear() throws {
        let factor = 0.91 / SolarLayoutDetector.derate
        let y2022 = Self.makeYear(
            2022,
            months: (1 ... 12).map { Self.makeMonth($0, factor: factor) })
        let y2023 = Self.makeYear(
            2023,
            months: [Self.makeMonth(4, factor: factor * 0.98)])
        let score = try Self.classifyScore(
            years: [y2022, y2023],
            manual: manualLayout(
                for: [.face(180, tilt: 25, kw: 5)],
                installDates: [Self.date(2019, 1, 1)]),
            now: Self.date(2023, 6, 1))
        let presentation = SolarHealthScorePresentation(score: score, locale: Self.enUS)

        #expect(presentation.headline == "98% of 2022")
        #expect(presentation.efficiencyLabel == "In 2022")
        #expect(presentation.efficiencyValue.hasPrefix("91% of its"))
        #expect(presentation.olderPanelsNote != nil)
    }

    @Test("Restart and panel-check notes appear when they apply")
    func restartAndPanelCheckNotes() throws {
        let factor = 1.02 / SolarLayoutDetector.derate
        let y2023 = Self.makeYear(
            2023,
            months: [Self.makeMonth(6, factor: 1.00)])
        let y2024 = Self.makeYear(
            2024,
            months: (4 ... 12).map { Self.makeMonth($0, factor: factor) })
        let y2025 = Self.makeYear(
            2025,
            months: (1 ... 3).map { Self.makeMonth($0, factor: factor) })
        let planes: [SolarHealthPlane] = [
            .face(180, tilt: 25, kw: 5),
            .face(180, tilt: 25, kw: 5)
        ]
        let score = try Self.classifyScore(
            years: [y2023, y2024, y2025],
            manual: manualLayout(
                for: planes,
                installDates: [Self.date(2020, 1, 1), Self.date(2024, 4, 1)]),
            now: Self.date(2025, 6, 1))
        let presentation = SolarHealthScorePresentation(score: score, locale: Self.enUS)

        #expect(presentation.restartNote == "Baseline restarted when the 2024 system was added")
        #expect(
            presentation.panelCheckPrompt == "Your system makes more than its entered rating allows. "
                + "Check the panel count and wattage.")
    }

    @Test("Potential caption says what the system made as new")
    func potentialCaptionFormatsAsNewAndLegacy() {
        let asNew = SolarHealthReport.PotentialVsActual(
            day: "2026-05-03",
            expectedKwh: 41.2,
            actualKwh: 40.0,
            isAsNew: true)
        #expect(
            SolarHealthScorePresentation.potentialCaption(asNew, locale: Self.enUS)
                == "As new, your system made about 41.2 kWh on a clear day like 2026-05-03; yours made 40.0 kWh.")

        let legacy = SolarHealthReport.PotentialVsActual(
            day: "2026-05-03",
            expectedKwh: 41.2,
            actualKwh: 40.0,
            isAsNew: false)
        #expect(
            SolarHealthScorePresentation.potentialCaption(legacy, locale: Self.enUS)
                == "Expected 41.2 kWh on a clear day like 2026-05-03; yours made 40.0 kWh.")
    }
}
