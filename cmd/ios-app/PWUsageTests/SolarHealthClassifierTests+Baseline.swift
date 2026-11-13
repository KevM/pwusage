import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health classification against the site baseline")
struct SolarHealthClassifierBaselineTests {
    private static let south = [SolarHealthPlane.face(180, tilt: 25, kw: 5)]

    private static func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        return Calendar(identifier: .gregorian).date(from: components) ?? Date(timeIntervalSince1970: 0)
    }

    private static func makeMonth(_ month: Int, factor: Double, clearDays: Int = 10) -> SolarHealthMonth {
        SolarHealthMonth(
            month: month,
            capacity: SolarHealthCapacity(
                site: factor,
                directions: [.init(azimuth: 180, factor: factor)],
                clearDays: clearDays))
    }

    private static func makeYear(
        _ year: Int,
        months: [SolarHealthMonth],
        siteFactor: Double = 1.10,
        dailyRatios: [SolarDailyRatio] = []
    ) -> SolarHealthYear {
        let totalDays = months.reduce(0) { $0 + $1.capacity.clearDays }
        return SolarHealthYear(
            year: year,
            key: "k-\(year)",
            clearDays: max(totalDays, dailyRatios.count),
            capacity: SolarHealthCapacity(
                site: siteFactor,
                directions: [.init(azimuth: 180, factor: siteFactor)],
                clearDays: max(totalDays, dailyRatios.count)),
            months: months,
            shade: [],
            dailyRatios: dailyRatios)
    }

    private static func makeManualResult(
        years: [SolarHealthYear],
        installDates: [Date?]? = nil
    ) throws -> (SolarHealthResult, ManualSolarLayout) {
        let manual = manualLayout(for: Self.south, installDates: installDates)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let result = SolarHealthResult(
            reference: reference,
            years: years,
            referenceScale: 1.0,
            recomputedYears: [years.last?.year ?? 2025])
        return (result, manual)
    }

    private static func frozenYears(currentMultiplier: Double) -> [SolarHealthYear] {
        let y2024 = Self.makeYear(
            2024,
            months: (4 ... 12).map { Self.makeMonth($0, factor: 1.10) })
        let y2025Months = (1 ... 3).map { Self.makeMonth($0, factor: 1.10) }
            + (4 ... 6).map { Self.makeMonth($0, factor: 1.10 * currentMultiplier) }
        let y2025 = Self.makeYear(2025, months: y2025Months)
        return [y2024, y2025]
    }

    @Test("A frozen site reports score vs new, rated efficiency and per-face scores")
    func frozenSiteReportsScoreAndRatedEfficiency() throws {
        let (result, manual) = try Self.makeManualResult(years: Self.frozenYears(currentMultiplier: 0.98))
        let report = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 7, 1))

        let score = try #require(report.healthScore)
        #expect(abs(score.scoreVsNew - 0.98) < 1e-9)
        #expect(abs(score.ratedEfficiency - 1.10 * 0.85) < 1e-9)
        #expect(score.comparedMonths == 3)
        #expect(!score.isProvisional)
        #expect(!score.isBelowBand)
        #expect(!score.isAboveHealthyRange)
        #expect(score.perDirection.count == 1)
        #expect(abs((score.perDirection.first?.factor ?? 0) - 0.98) < 1e-9)
        #expect(report.baseline == score.baseline)
    }

    @Test("Emphasis starts below 92% of new")
    func emphasisStartsBelow92Percent() throws {
        let now = Self.date(2025, 7, 1)
        let (belowResult, belowManual) = try Self.makeManualResult(
            years: Self.frozenYears(currentMultiplier: 0.91))
        let belowReport = SolarHealthClassifier.classify(belowResult, manual: belowManual, now: now)
        let belowScore = try #require(belowReport.healthScore)
        #expect(belowScore.isBelowBand)

        let (withinResult, withinManual) = try Self.makeManualResult(
            years: Self.frozenYears(currentMultiplier: 0.93))
        let withinReport = SolarHealthClassifier.classify(withinResult, manual: withinManual, now: now)
        let withinScore = try #require(withinReport.healthScore)
        #expect(!withinScore.isBelowBand)
    }

    @Test("Potential vs actual is scaled by that month's baseline")
    func potentialVsActualScaledByMonthBaseline() throws {
        let install = Self.date(2024, 5, 1)
        let y2024 = Self.makeYear(
            2024,
            months: [
                Self.makeMonth(4, factor: 0.90),
                Self.makeMonth(5, factor: 1.00),
                Self.makeMonth(6, factor: 1.10),
                Self.makeMonth(9, factor: 1.05),
                Self.makeMonth(12, factor: 1.05)
            ])
        let y2025 = Self.makeYear(
            2025,
            months: [Self.makeMonth(3, factor: 1.05)],
            dailyRatios: [SolarDailyRatio(day: "2025-06-10", ratio: 1.0, expectedKwh: 30, actualKwh: 32)])
        let (result, manual) = try Self.makeManualResult(years: [y2024, y2025], installDates: [install])
        let report = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 7, 1))

        let pva = try #require(report.potentialVsActual)
        #expect(abs(pva.expectedKwh - 33.0) < 1e-9)
        #expect(pva.isAsNew)

        let y2025Fallback = Self.makeYear(
            2025,
            months: [Self.makeMonth(3, factor: 1.05)],
            dailyRatios: [SolarDailyRatio(day: "2025-04-10", ratio: 1.0, expectedKwh: 30, actualKwh: 31)])
        let (fallbackResult, _) = try Self.makeManualResult(years: [y2024, y2025Fallback], installDates: [install])
        let fallbackReport = SolarHealthClassifier.classify(
            fallbackResult, manual: manual, now: Self.date(2025, 7, 1))

        let fallbackPva = try #require(fallbackReport.potentialVsActual)
        let baseline = try #require(fallbackReport.baseline)
        #expect(abs(baseline.siteFactor - 1.05) < 1e-9)
        #expect(abs(fallbackPva.expectedKwh - 30 * 1.05) < 1e-9)
        #expect(fallbackPva.isAsNew)
    }

    @Test("Entered panels with no monthly factor yet have no score and no low-output finding")
    func enteredPanelsWithNoMonthlyFactorHaveNoScore() throws {
        let emptyYear = SolarHealthYear(
            year: 2025,
            key: "k-2025",
            clearDays: 0,
            capacity: nil,
            months: [],
            shade: [],
            dailyRatios: [])
        let (result, manual) = try Self.makeManualResult(years: [emptyYear])
        let report = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 7, 1))

        #expect(report.healthScore == nil)
        #expect(!report.allFindings.contains { $0.kind == .lowOutput })
    }

    @Test("Detected-only sites keep today's report")
    func detectedOnlySitesKeepTodaysReport() throws {
        let years = Self.frozenYears(currentMultiplier: 0.98).enumerated().map { index, year in
            if index == 1 {
                return SolarHealthYear(
                    year: year.year,
                    key: year.key,
                    clearDays: year.clearDays,
                    capacity: year.capacity,
                    months: year.months,
                    shade: year.shade,
                    dailyRatios: [SolarDailyRatio(day: "2025-06-10", ratio: 1.0, expectedKwh: 30, actualKwh: 31)])
            }
            return year
        }
        let detected = DetectedSolarLayout(
            status: .detected,
            confidence: "high",
            reasons: [],
            planes: [.init(
                azimuth: 180,
                tilt: 25,
                dcKwp: 5,
                effectiveKw: 5 * SolarLayoutDetector.derate,
                azimuthRange90: [170, 190],
                tiltRange90: [20, 30])],
            acClipKw: nil,
            historyDays: 365,
            clearDays: 120,
            firstDay: nil,
            lastDay: nil)
        let reference = try #require(SolarHealthReference(manual: nil, detected: detected))
        let result = SolarHealthResult(
            reference: reference,
            years: years,
            referenceScale: 1.0,
            recomputedYears: [2025])
        let report = SolarHealthClassifier.classify(result, manual: nil, now: Self.date(2025, 7, 1))

        #expect(report.healthScore == nil)
        #expect(report.baseline == nil)
        let pva = try #require(report.potentialVsActual)
        #expect(!pva.isAsNew)
        #expect(pva.expectedKwh == 30)
        #expect(report.changeOverTime.years.map(\.factor) == years.compactMap { $0.capacity?.site })
    }

    @Test("Low output on a frozen baseline is raised at its usual confidence")
    func lowOutputOnFrozenBaseline() throws {
        let months = (1 ... 12).map { Self.makeMonth($0, factor: 0.70 / 0.85, clearDays: 10) }
        let (result, manual) = try Self.makeManualResult(years: [Self.makeYear(2024, months: months)])
        let report = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 2, 1))

        let finding = try #require(report.allFindings.first { $0.kind == .lowOutput })
        #expect(finding.title == "Output below what panels of this size usually make")
        #expect(
            finding.detail == "When new, your system made about 70% of its rating on clear days. "
                + "Healthy systems make 82–98%.")
        #expect(finding.confidence == .confident)
    }

    @Test("While provisional, low output needs below 75% and 10 clear days and is a first estimate")
    func lowOutputWhileProvisional() throws {
        let now = Self.date(2025, 7, 1)

        let (lowResult, lowManual) = try Self.makeManualResult(
            years: [Self.makeYear(2025, months: [Self.makeMonth(6, factor: 0.70 / 0.85, clearDays: 12)])])
        let lowReport = SolarHealthClassifier.classify(lowResult, manual: lowManual, now: now)
        let finding = try #require(lowReport.allFindings.first { $0.kind == .lowOutput })
        #expect(finding.confidence == .initial)

        let (fewDaysResult, fewDaysManual) = try Self.makeManualResult(
            years: [Self.makeYear(2025, months: [Self.makeMonth(6, factor: 0.70 / 0.85, clearDays: 8)])])
        let fewDaysReport = SolarHealthClassifier.classify(fewDaysResult, manual: fewDaysManual, now: now)
        #expect(!fewDaysReport.allFindings.contains { $0.kind == .lowOutput })

        let (midEffResult, midEffManual) = try Self.makeManualResult(
            years: [Self.makeYear(2025, months: [Self.makeMonth(6, factor: 0.78 / 0.85, clearDays: 30)])])
        let midEffReport = SolarHealthClassifier.classify(midEffResult, manual: midEffManual, now: now)
        #expect(!midEffReport.allFindings.contains { $0.kind == .lowOutput })
    }

    @Test("High rated efficiency raises the panel prompt only once frozen")
    func highRatedEfficiencyPanelPrompt() throws {
        let months = (1 ... 12).map { Self.makeMonth($0, factor: 1.20, clearDays: 10) }
        let (result, manual) = try Self.makeManualResult(years: [Self.makeYear(2024, months: months)])

        let frozenReport = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 2, 1))
        let frozenScore = try #require(frozenReport.healthScore)
        #expect(frozenScore.isAboveHealthyRange)
        #expect(frozenReport.allFindings.isEmpty)

        let provisionalReport = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2024, 12, 15))
        let provisionalScore = try #require(provisionalReport.healthScore)
        #expect(!provisionalScore.isAboveHealthyRange)
    }

    @Test("As-new expected energy scales the reference before the inverter clip")
    func potentialVsActualClipsAfterBaseline() throws {
        let install = Self.date(2024, 5, 1)
        let y2024 = Self.makeYear(2024, months: (5 ... 9).map { Self.makeMonth($0, factor: 1.10) })
        let y2025 = Self.makeYear(
            2025,
            months: [Self.makeMonth(3, factor: 1.10)],
            dailyRatios: [SolarDailyRatio(day: "2025-06-10", ratio: 1.0, expectedKwh: 4.8, actualKwh: 5)])
        var (result, manual) = try Self.makeManualResult(years: [y2024, y2025], installDates: [install])
        let clipped = SolarHealthYearFit.ScaledEnergyInputs(
            clipKw: 5, dayPowers: ["2025-06-10": Array(repeating: 4.8, count: 12)])
        result.latestDayEnergy = clipped
        let report = SolarHealthClassifier.classify(result, manual: manual, now: Self.date(2025, 7, 1))

        let pva = try #require(report.potentialVsActual)
        #expect(pva.isAsNew)
        #expect(pva.expectedKwh <= 5)
        #expect(pva.expectedKwh < 4.8 * 1.10)
        #expect(pva.expectedKwh == clipped.expectedDailyKwh(referenceScale: 1.10)["2025-06-10"])
    }

    @Test("Baseline months are stamped on the Gregorian calendar")
    func baselineStampsAreGregorian() {
        let stamp = SolarHealthMonthStamp(Self.date(2024, 4, 15), calendar: .gregorianStamps)
        #expect(stamp == SolarHealthMonthStamp(year: 2024, month: 4))
        #expect(Calendar.gregorianStamps.identifier == .gregorian)
    }
}
