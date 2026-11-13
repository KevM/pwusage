import Foundation
@testable import PWUsage
import Testing

/// Known-decline histories through the shipped pass and estimator. Writes synthetic.md into the
/// research folder; disabled without PWUSAGE_SOLAR_BACKTEST_DIR because a run takes minutes.
@Suite("Solar degradation backtest: synthetic", .serialized)
struct DegradationBacktestSyntheticTests {
    private static let scope = SolarForecastSiteScope(accountScopeID: "synthetic", siteID: "synthetic")
    private static let planes = [
        SolarHealthPlane.face(90, tilt: 18.4, kw: 4.76), SolarHealthPlane.face(270, tilt: 18.4, kw: 3.4)
    ]
    private static let from = DateComponents(year: 2023, month: 12, day: 1)
    private static let through = DateComponents(year: 2026, month: 10, day: 31)

    struct Case {
        let name: String
        let trueRate: Double
        var site: SyntheticSolarSite
        var manual: ManualSolarLayout
        var keep: (Date) -> Bool = { _ in true }
        /// A second array whose production adds to `site`'s from its date on.
        var added: (site: SyntheticSolarSite, from: Date)?

        func samples(from: DateComponents, through: DateComponents) -> [(timestamp: Date, solarWh: Double)] {
            var out = site.samples(from: from, through: through)
            if let added {
                let extra = Dictionary(
                    added.site.samples(from: from, through: through).map { ($0.timestamp, $0.solarWh) },
                    uniquingKeysWith: +)
                out = out.map { sample in
                    sample.timestamp >= added.from
                        ? (sample.timestamp, sample.solarWh + (extra[sample.timestamp] ?? 0)) : sample
                }
            }
            return out.filter { keep($0.timestamp) }
        }
    }

    @Test(.enabled(if: DegradationBacktestInputs.isEnabled))
    func writesSyntheticReport() throws {
        let path = try #require(ProcessInfo.processInfo.environment[DegradationBacktestInputs.environmentKey])
        let now = try #require(ISO8601DateFormatter().date(from: "2026-11-13T12:00:00Z"))
        var lines = [
            "# Synthetic known-decline cases", "",
            "case | true %/yr | estimate %/yr | error pp/yr | confidence | matched pairs | finding",
            "--- | --- | --- | --- | --- | --- | ---"
        ]
        for testCase in try Self.cases() {
            let samples = testCase.samples(from: Self.from, through: Self.through)
            let reference = try #require(SolarHealthReference(manual: testCase.manual, detected: nil))
            let place = SolarHealthYearFit.Place(
                reference: reference, latitude: testCase.site.latitude, longitude: testCase.site.longitude,
                timeZone: testCase.site.timeZone)
            let folder = FileManager.default.temporaryDirectory.appending(path: "synthetic-\(UUID().uuidString)")
            let context = SolarHealthPass.Context(
                scope: Self.scope, cache: SolarHealthCache(directory: folder), now: now)
            let result = try SolarHealthPass.compute(
                samples: samples, place: place, context: context, checkCancellation: {})
            let analysis = DegradationBacktest.trend(result, manual: testCase.manual, now: now)
            let estimate = analysis.change.agingPercentPerYear
            let pairCount = DegradationBacktest.pairs(analysis.change.months).count
            lines.append(
                "\(testCase.name) | \(String(format: "%+.2f", testCase.trueRate)) | "
                    + (estimate.map { String(format: "%+.2f", $0) } ?? "none") + " | "
                    + (estimate.map { String(format: "%+.2f", $0 - testCase.trueRate) } ?? "-") + " | "
                    + (analysis.change.agingConfidence.map { "\($0)" } ?? "-") + " | "
                    + "\(pairCount) | \(analysis.finding == nil ? "no" : "YES")")
        }
        try Data(lines.joined(separator: "\n").utf8)
            .write(to: URL(fileURLWithPath: path, isDirectory: true).appending(path: "synthetic.md"))
    }

    /// Capacity after `rate` %/yr of continuous decline since the first month.
    private static func declining(_ rate: Double) -> (Int, Int) -> Double {
        { year, month in
            let years = Double((year - 2023) * 12 + month - 12) / 12
            return pow(1 + rate / 100, years)
        }
    }

    private static func cases() throws -> [Case] {
        let base = SyntheticSolarSite(planes: planes)
        let manual = manualLayout(for: planes)
        var cases = [0.0, -0.5, -1.5].map { rate in
            var site = base
            site.capacity = declining(rate)
            return Case(name: String(format: "steady %+.1f%%/yr", rate), trueRate: rate, site: site, manual: manual)
        }
        cases += try sparseCases(base: base, manual: manual)
        cases += shadeCases(base: base, manual: manual)
        cases += try installCases(base: base)
        return cases
    }

    /// Two winters 2 years apart and nothing between, the second one 3% low for a reason other than aging.
    private static func sparseCases(base: SyntheticSolarSite, manual: ManualSolarLayout) throws -> [Case] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = base.timeZone
        let firstEnd = try #require(calendar.date(from: DateComponents(year: 2024, month: 3)))
        let secondStart = try #require(calendar.date(from: DateComponents(year: 2026, month: 1)))
        let secondEnd = try #require(calendar.date(from: DateComponents(year: 2026, month: 3)))
        let keep: (Date) -> Bool = { $0 < firstEnd || ($0 >= secondStart && $0 < secondEnd) }
        var dirty = base
        dirty.capacity = { year, _ in year == 2026 ? 0.97 : 1 }
        var clean = base
        clean.capacity = declining(-0.5)
        return [
            Case(name: "sparse overlap, -0.5%/yr", trueRate: -0.5, site: clean, manual: manual, keep: keep),
            Case(
                name: "sparse overlap, stable, one 3% low winter", trueRate: 0, site: dirty, manual: manual,
                keep: keep)
        ]
    }

    /// A tree east of the array that shades the low morning sun a little higher each year.
    private static func shadeCases(base: SyntheticSolarSite, manual: ManualSolarLayout) -> [Case] {
        var site = base
        site.shaded = { day, azimuth, elevation in
            let years = Double(DegradationBacktest.year(of: day) - 2023)
                + Double(DegradationBacktest.month(of: day)) / 12
            return azimuth < 130 && elevation < 8 + 3 * years
        }
        return [Case(name: "stable panels, growing east shade", trueRate: 0, site: site, manual: manual)]
    }

    /// A west system added in March 2025, with and without its install date entered.
    private static func installCases(base: SyntheticSolarSite) throws -> [Case] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = base.timeZone
        let added = try #require(calendar.date(from: DateComponents(year: 2025, month: 3, day: 1)))
        var east = base
        east.planes = [planes[0]]
        var west = base
        west.planes = [planes[1]]
        return [
            Case(name: "west system added 2025-03, date entered", trueRate: 0, site: east,
                 manual: manualLayout(for: planes, installDates: [nil, added]), added: (west, added)),
            Case(name: "west system added 2025-03, no date", trueRate: 0, site: east,
                 manual: manualLayout(for: planes), added: (west, added))
        ]
    }
}
