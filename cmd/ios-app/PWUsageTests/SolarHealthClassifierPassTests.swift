import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health classification end-to-end")
struct SolarHealthClassifierPassTests {
    private static let south = [SolarHealthPlane.face(180, tilt: 25, kw: 5)]
    private static let scope = SolarForecastSiteScope(accountScopeID: "test-account", siteID: "site-1")

    private static func folder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("solar-health-\(UUID().uuidString)")
    }

    private static func runPass(
        site: SyntheticSolarSite,
        from: DateComponents,
        through: DateComponents,
        now: Date,
        manual: ManualSolarLayout? = nil
    ) throws -> (result: SolarHealthResult, manual: ManualSolarLayout) {
        let manual = manual ?? manualLayout(for: site.planes)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let timeZone = try #require(TimeZone(identifier: "America/Chicago"))
        let place = SolarHealthYearFit.Place(reference: reference, latitude: 43.4, longitude: -87.9, timeZone: timeZone)
        let samples = site.samples(from: from, through: through)
        let context = SolarHealthPass.Context(scope: scope, cache: SolarHealthCache(directory: folder()), now: now)
        let result = try SolarHealthPass.compute(
            samples: samples, place: place, context: context, checkCancellation: {})
        return (result, manual)
    }

    @Test("Synthetic clean site produces no findings")
    func cleanSyntheticSite() throws {
        let site = SyntheticSolarSite(planes: Self.south)
        let now = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 15)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2026, month: 4, day: 1),
            through: DateComponents(year: 2026, month: 5, day: 15),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        #expect(report.visibleFindings.isEmpty)
        let pva = try #require(report.potentialVsActual)
        #expect(pva.expectedKwh > 0)
        #expect(abs(pva.ratio - 1.0) < 0.03)
    }

    @Test("Synthetic 5% soiling drop and recovery is classified as soiling")
    func syntheticSoiling() throws {
        let timeZone = try #require(TimeZone(identifier: "America/Chicago"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = try #require(calendar.date(from: DateComponents(year: 2026, month: 4, day: 1)))

        let site = SyntheticSolarSite(planes: Self.south, dayScale: { day in
            let fmt = DateFormatter()
            fmt.calendar = calendar
            fmt.timeZone = timeZone
            fmt.dateFormat = "yyyy-MM-dd"
            guard let date = fmt.date(from: day) else { return 1 }
            let offset = calendar.dateComponents([.day], from: start, to: date).day ?? 0
            if offset >= 5 && offset <= 15 {
                let progress = Double(offset - 5) / 10.0
                return 1.0 - 0.055 * progress
            }
            return 1.0
        })
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 6, day: 1)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2026, month: 4, day: 1),
            through: DateComponents(year: 2026, month: 5, day: 15),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        let soiling = try #require(report.visibleFindings.first { $0.kind == .soiling })
        #expect(soiling.clearDays >= 5)
        #expect(report.dirtLevel.lastRecoveredDay != nil)
    }

    @Test("A healthy new site reads 100% and is provisional in its first clear weeks")
    func healthyNewSiteProvisional() throws {
        let site = SyntheticSolarSite(planes: Self.south)
        let now = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 15)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2026, month: 4, day: 1),
            through: DateComponents(year: 2026, month: 5, day: 15),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        let score = try #require(report.healthScore)
        #expect(score.scoreVsNew == 1.0)
        #expect(score.isProvisional)
        #expect(abs(score.ratedEfficiency - 0.85) < 0.03)
        #expect(report.visibleFindings.isEmpty)
    }

    @Test("A stable site stays within 1% of new and a declining one reads about 97% after two years")
    func stableAndDecliningSites() throws {
        let stableSite = SyntheticSolarSite(planes: Self.south, capacity: { _, _ in 1 })
        let stableNow = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 1, day: 15)))
        let (stableResult, stableManual) = try Self.runPass(
            site: stableSite,
            from: DateComponents(year: 2024, month: 1, day: 1),
            through: DateComponents(year: 2025, month: 12, day: 31),
            now: stableNow)
        let stableReport = SolarHealthClassifier.classify(stableResult, manual: stableManual, now: stableNow)
        let stableScore = try #require(stableReport.healthScore)
        #expect(abs(stableScore.scoreVsNew - 1) < 0.01)
        #expect(!stableScore.isProvisional)

        let decliningSite = SyntheticSolarSite(planes: Self.south, capacity: { year, month in
            pow(0.985, Double(year - 2024) + Double(month - 1) / 12)
        })
        let decliningNow = try #require(Calendar.current.date(from: DateComponents(year: 2027, month: 1, day: 15)))
        let (decliningResult, decliningManual) = try Self.runPass(
            site: decliningSite,
            from: DateComponents(year: 2024, month: 1, day: 1),
            through: DateComponents(year: 2026, month: 12, day: 31),
            now: decliningNow)
        let decliningReport = SolarHealthClassifier.classify(
            decliningResult, manual: decliningManual, now: decliningNow)
        let decliningScore = try #require(decliningReport.healthScore)
        #expect(abs(decliningScore.scoreVsNew - 0.970) < 0.01)
    }

    @Test("A site at 70% of its rating raises low output once frozen")
    func lowOutputSiteOnceFrozen() throws {
        let site = SyntheticSolarSite(planes: Self.south, capacity: { _, _ in 0.70 / 0.85 })
        let now = try #require(Calendar.current.date(from: DateComponents(year: 2025, month: 2, day: 15)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2024, month: 1, day: 1),
            through: DateComponents(year: 2024, month: 12, day: 31),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        #expect(report.allFindings.contains { $0.kind == .lowOutput })
    }

    @Test("Too few panels entered raises the check-your-panels prompt")
    func tooFewPanelsEntered() throws {
        let site = SyntheticSolarSite(planes: Self.south, capacity: { _, _ in 1.10 / 0.9 })
        let now = try #require(Calendar.current.date(from: DateComponents(year: 2025, month: 2, day: 15)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2024, month: 1, day: 1),
            through: DateComponents(year: 2024, month: 12, day: 31),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        let score = try #require(report.healthScore)
        #expect(score.isAboveHealthyRange)
        #expect(!report.allFindings.contains { $0.kind == .lowOutput })
    }

    @Test("A summer-only site is provisional with its seasons and clear days, and no warnings")
    func summerOnlySite() throws {
        let site = SyntheticSolarSite(planes: Self.south)
        let now = try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 15)))
        let (result, manual) = try Self.runPass(
            site: site,
            from: DateComponents(year: 2026, month: 6, day: 1),
            through: DateComponents(year: 2026, month: 8, day: 31),
            now: now)
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)

        let score = try #require(report.healthScore)
        #expect(score.isProvisional)
        #expect(score.baseline.seasonsCovered == 1)
        #expect(score.baseline.clearDays > 0)
        #expect(!score.isBelowBand)
        #expect(!report.allFindings.contains { $0.kind == .lowOutput })
    }
}
