import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health classification")
struct SolarHealthClassifierTests {
    private static let south = [SolarHealthPlane.face(180, tilt: 25, kw: 5)]

    private static func makeResult(years: [SolarHealthYear]) throws -> (SolarHealthResult, ManualSolarLayout) {
        let manual = manualLayout(for: Self.south)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let result = SolarHealthResult(
            reference: reference, years: years, referenceScale: 1.0, recomputedYears: [years.last?.year ?? 2026])
        return (result, manual)
    }

    private static func makeMask(horizon: [Double]? = nil) -> SolarShadeMap {
        let base = horizon ?? [Double](repeating: -.infinity, count: 36)
        return SolarShadeMap(ShadeMask(horizon: base, hotBins: []))
    }

    @Test("Clean site produces no findings and shows potential vs actual")
    func cleanSiteProducesNoFindings() throws {
        let ratios = (1 ... 12).map { day in
            SolarDailyRatio(
                day: String(format: "2026-04-%02d", day), ratio: 1.0, expectedKwh: 32.0, actualKwh: 32.0)
        }
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 12,
            capacity: SolarHealthCapacity(site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 12),
            months: [SolarHealthMonth(
                month: 4,
                capacity: SolarHealthCapacity(
                    site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 12))],
            shade: [],
            dailyRatios: ratios)
        let (result, manual) = try Self.makeResult(years: [year])
        let report = SolarHealthClassifier.classify(result, manual: manual)

        #expect(report.visibleFindings.isEmpty)
        let pva = try #require(report.potentialVsActual)
        #expect(pva.expectedKwh == 32.0)
        #expect(pva.actualKwh == 32.0)
        #expect(!report.shading.isShaded)
        #expect(!report.dirtLevel.isActive)
        #expect(!report.changeOverTime.hasEnoughHistoryForTrend)
    }

    @Test("Soiling recovery only credits rain between clear-day readings", arguments: [
        [], ["2026-04-07"], ["2026-04-08"], ["2026-04-09"], ["2026-04-10"]
    ] as [[String]])
    func fivePercentLossAndRecoveryIsSoiling(_ rainDays: [String]) throws {
        let ratios = [
            SolarDailyRatio(day: "2026-04-01", ratio: 1.00, expectedKwh: 30, actualKwh: 30.0),
            SolarDailyRatio(day: "2026-04-02", ratio: 0.99, expectedKwh: 30, actualKwh: 29.7),
            SolarDailyRatio(day: "2026-04-03", ratio: 0.98, expectedKwh: 30, actualKwh: 29.4),
            SolarDailyRatio(day: "2026-04-05", ratio: 0.97, expectedKwh: 30, actualKwh: 29.1),
            SolarDailyRatio(day: "2026-04-06", ratio: 0.96, expectedKwh: 30, actualKwh: 28.8),
            SolarDailyRatio(day: "2026-04-07", ratio: 0.95, expectedKwh: 30, actualKwh: 28.5),
            SolarDailyRatio(day: "2026-04-09", ratio: 1.00, expectedKwh: 30, actualKwh: 30.0)
        ]
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 10,
            capacity: SolarHealthCapacity(site: 0.98, directions: [.init(azimuth: 180, factor: 0.98)], clearDays: 10),
            months: [], shade: [], dailyRatios: ratios)
        let (result, manual) = try Self.makeResult(years: [year])
        let report = SolarHealthClassifier.classify(result, manual: manual, rainDays: Set(rainDays))

        let soiling = try #require(report.visibleFindings.first { $0.kind == .soiling })
        #expect(soiling.clearDays >= 5)
        #expect(soiling.detail.contains("after rain") == (rainDays == ["2026-04-08"]))
        #expect(report.dirtLevel.lastRecoveredDay == "2026-04-09")
    }

    @Test("Summer-only shading is reported at the right azimuth and not as spring growth")
    func summerOnlyShadingNotReportedAsSpringGrowth() throws {
        var summerHorizon = [Double](repeating: -.infinity, count: 36)
        summerHorizon[9] = 18.0
        summerHorizon[10] = 20.0
        summerHorizon[11] = 16.0

        let year2025 = SolarHealthYear(
            year: 2025, key: "k-2025", clearDays: 40,
            capacity: SolarHealthCapacity(site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 40),
            months: [],
            shade: [
                SolarSeasonShade(season: .spring, map: Self.makeMask(), clearDays: 10),
                SolarSeasonShade(season: .summer, map: Self.makeMask(horizon: summerHorizon), clearDays: 10)
            ],
            dailyRatios: [])
        let year2026 = SolarHealthYear(
            year: 2026, key: "k-2026", clearDays: 40,
            capacity: SolarHealthCapacity(site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 40),
            months: [],
            shade: [
                SolarSeasonShade(season: .spring, map: Self.makeMask(), clearDays: 10),
                SolarSeasonShade(season: .summer, map: Self.makeMask(horizon: summerHorizon), clearDays: 10)
            ],
            dailyRatios: [])

        let (result, manual) = try Self.makeResult(years: [year2025, year2026])
        let report = SolarHealthClassifier.classify(result, manual: manual)

        let summerShade = try #require(report.visibleFindings.first { $0.kind == .shading && $0.season == .summer })
        let from = try #require(summerShade.azimuthFrom)
        let upper = try #require(summerShade.azimuthTo)
        #expect(from <= 100 && upper >= 110)

        let springGrowth = report.allFindings.filter { $0.kind == .shadingGrowth && $0.season == .spring }
        #expect(springGrowth.isEmpty)
    }

    @Test("A 1% per year decline over five years is measured within ±0.3 points")
    func onePercentPerYearDeclineOverFiveYears() throws {
        let years: [SolarHealthYear] = (2022 ... 2026).map { year in
            let factor = 1.0 - 0.01 * Double(year - 2022)
            let months = (1 ... 12).map { month in
                SolarHealthMonth(
                    month: month,
                    capacity: SolarHealthCapacity(
                        site: factor,
                        directions: [.init(azimuth: 180, factor: factor)],
                        clearDays: 10))
            }
            let ratio = SolarDailyRatio(
                day: "\(year)-06-15", ratio: factor, expectedKwh: 30, actualKwh: 30 * factor)
            return SolarHealthYear(
                year: year,
                key: "k-\(year)",
                clearDays: 120,
                capacity: SolarHealthCapacity(
                    site: factor,
                    directions: [.init(azimuth: 180, factor: factor)],
                    clearDays: 120),
                months: months,
                shade: [],
                dailyRatios: [ratio])
        }
        let (result, manual) = try Self.makeResult(years: years)
        let report = SolarHealthClassifier.classify(result, manual: manual)

        let measured = try #require(report.changeOverTime.agingPercentPerYear)
        #expect(abs(measured - (-1.0)) <= 0.3)
        #expect(report.changeOverTime.agingConfidence == .confident)
        #expect(report.visibleFindings.contains { $0.kind == .aging })
    }

    @Test("Abrupt 12% drop that stays down is classified as a step fault")
    func abruptDropIsStepFault() throws {
        let ratios: [SolarDailyRatio] = (1 ... 10).map { day in
            let ratio = day <= 6 ? 1.0 : 0.86
            return SolarDailyRatio(
                day: String(format: "2026-05-%02d", day),
                ratio: ratio,
                expectedKwh: 30,
                actualKwh: 30 * ratio)
        }
        let year = SolarHealthYear(
            year: 2026,
            key: "k-2026",
            clearDays: 10,
            capacity: SolarHealthCapacity(site: 0.94, directions: [.init(azimuth: 180, factor: 0.94)], clearDays: 10),
            months: [],
            shade: [],
            dailyRatios: ratios)
        let (result, manual) = try Self.makeResult(years: [year])
        let report = SolarHealthClassifier.classify(result, manual: manual)

        let fault = try #require(report.visibleFindings.first { $0.kind == .stepFault })
        #expect(fault.clearDays == 4)
        #expect(!report.dirtLevel.isActive)
    }

    @Test("Isolated hot bins without horizon segments are reported as shading")
    func isolatedHotBinsReportedAsShading() throws {
        let horizon = [Double](repeating: -.infinity, count: 36)
        let map = SolarShadeMap(ShadeMask(horizon: horizon, hotBins: [ShadeHotBin(azimuth: 250, elevation: 15)]))
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 20,
            capacity: SolarHealthCapacity(site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 20),
            months: [],
            shade: [SolarSeasonShade(season: .autumn, map: map, clearDays: 8)],
            dailyRatios: [])
        let (result, manual) = try Self.makeResult(years: [year])
        let report = SolarHealthClassifier.classify(result, manual: manual)

        #expect(report.shading.isShaded)
        let finding = try #require(report.visibleFindings.first { $0.kind == .shading && $0.season == .autumn })
        #expect(finding.azimuthFrom == 250)
        #expect(finding.azimuthTo == 260)
    }

    @Test("Unobserved historical bin does not trigger shading growth, observed open bin does")
    func unobservedPreviousHorizonDoesNotReportShadingGrowth() throws {
        let openHorizon = [Double](repeating: -.infinity, count: 36)
        var shadedHorizon = openHorizon
        shadedHorizon[10] = 18.0

        let unobservedOld = SolarShadeMap(ShadeMask(
            horizon: openHorizon, hotBins: [], observedBins: [Bool](repeating: false, count: 36)))
        var observedFlags = [Bool](repeating: false, count: 36)
        observedFlags[10] = true
        let observedOld = SolarShadeMap(ShadeMask(horizon: openHorizon, hotBins: [], observedBins: observedFlags))
        let latestMap = SolarShadeMap(ShadeMask(horizon: shadedHorizon, hotBins: [], observedBins: observedFlags))

        let cap = SolarHealthCapacity(site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 20)
        let y2025Unobs = SolarHealthYear(
            year: 2025, key: "u-2025", clearDays: 20, capacity: cap, months: [],
            shade: [SolarSeasonShade(season: .summer, map: unobservedOld, clearDays: 10)], dailyRatios: [])
        let y2025Obs = SolarHealthYear(
            year: 2025, key: "o-2025", clearDays: 20, capacity: cap, months: [],
            shade: [SolarSeasonShade(season: .summer, map: observedOld, clearDays: 10)], dailyRatios: [])
        let y2026 = SolarHealthYear(
            year: 2026, key: "2026", clearDays: 20, capacity: cap, months: [],
            shade: [SolarSeasonShade(season: .summer, map: latestMap, clearDays: 10)], dailyRatios: [])

        let (unobsResult, manual) = try Self.makeResult(years: [y2025Unobs, y2026])
        let unobsReport = SolarHealthClassifier.classify(unobsResult, manual: manual)
        #expect(!unobsReport.allFindings.contains { $0.kind == .shadingGrowth })

        let (obsResult, _) = try Self.makeResult(years: [y2025Obs, y2026])
        let obsReport = SolarHealthClassifier.classify(obsResult, manual: manual)
        #expect(obsReport.allFindings.contains { $0.kind == .shadingGrowth && $0.season == .summer })
    }
}
