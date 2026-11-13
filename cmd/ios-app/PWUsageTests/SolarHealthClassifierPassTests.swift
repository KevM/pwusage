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
        site: SyntheticSolarSite, from: DateComponents, through: DateComponents, now: Date
    ) throws -> (result: SolarHealthResult, manual: ManualSolarLayout) {
        let manual = manualLayout(for: site.planes)
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
}
