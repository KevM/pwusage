import Foundation
@testable import PWUsage
import Testing

/// The health pass on synthetic production whose truth is known.
@Suite("Solar health pass")
struct SolarHealthPassTests {
    static let scope = SolarForecastSiteScope(accountScopeID: "health-account", siteID: "health-site")
    static let eastWest = [SolarHealthPlane.face(90, kw: 3), .face(270, kw: 3)]
    /// 2026-11-12: 2024 and 2025 are completed years, 2026 is the current one.
    static let now = Date(timeIntervalSince1970: 1_794_000_000)

    static func folder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("health-\(UUID().uuidString)")
    }

    static func samples(
        _ site: SyntheticSolarSite, years: ClosedRange<Int> = 2024 ... 2026, lastMonth: Int = 6
    ) -> [(timestamp: Date, solarWh: Double)] {
        site.samples(
            from: DateComponents(year: years.lowerBound, month: 1, day: 1),
            through: DateComponents(year: years.upperBound, month: years.upperBound == 2026 ? lastMonth : 12, day: 28))
    }

    static func place(
        _ planes: [SolarHealthPlane], layout: ManualSolarLayout? = nil, site: SyntheticSolarSite? = nil
    ) throws -> SolarHealthYearFit.Place {
        let reference = try #require(SolarHealthReference(manual: layout ?? manualLayout(for: planes), detected: nil))
        let site = site ?? SyntheticSolarSite(planes: planes)
        return SolarHealthYearFit.Place(
            reference: reference, latitude: site.latitude, longitude: site.longitude, timeZone: site.timeZone)
    }

    static func compute(
        _ samples: [(timestamp: Date, solarWh: Double)], _ place: SolarHealthYearFit.Place,
        cache: SolarHealthCache, now: Date = Self.now
    ) throws -> SolarHealthResult {
        try SolarHealthPass.compute(
            samples: samples, place: place, scope: scope, cache: cache, now: now, checkCancellation: {})
    }

    @Test func healthySiteGivesAFactorNearOneEveryYear() throws {
        let samples = Self.samples(SyntheticSolarSite(planes: Self.eastWest))
        let result = try Self.compute(
            samples, Self.place(Self.eastWest), cache: SolarHealthCache(directory: Self.folder()))
        #expect(result.years.map(\.year) == [2024, 2025, 2026])
        for year in result.years {
            let capacity = try #require(year.capacity, "\(year.year) capacity")
            #expect(abs(capacity.site - 1) < 0.02, "\(year.year) site factor \(capacity.site)")
            #expect(capacity.clearDays >= 40, "\(year.year) clear days")
        }
    }

    @Test func eastAndWestGetSeparateFactors() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        // The west roof loses 12% in 2025; the east roof does not.
        site.planes = [.face(90, kw: 3), .face(270, kw: 3 * 0.88)]
        let samples = Self.samples(site, years: 2025 ... 2025)
        let result = try Self.compute(
            samples, Self.place(Self.eastWest, site: site), cache: SolarHealthCache(directory: Self.folder()))
        let directions = try #require(result.years.first?.capacity?.directions)
        #expect(directions.count == 2)
        #expect(abs(directions[0].azimuth - 90) < 1)
        #expect(abs(directions[0].factor - 1) < 0.03, "east \(directions[0].factor)")
        #expect(abs(directions[1].factor - 0.88) < 0.03, "west \(directions[1].factor)")
    }

    @Test func twoSouthFacesShareOneFactor() throws {
        let south = [SolarHealthPlane.face(180, tilt: 20, kw: 3), .face(185, tilt: 35, kw: 2)]
        let samples = Self.samples(SyntheticSolarSite(planes: south), years: 2025 ... 2025)
        let result = try Self.compute(
            samples, Self.place(south), cache: SolarHealthCache(directory: Self.folder()))
        let capacity = try #require(result.years.first?.capacity)
        #expect(capacity.directions.count == 1)
        #expect(abs(capacity.directions[0].factor - capacity.site) < 1e-9)
        #expect(abs(capacity.site - 1) < 0.02)
    }

    @Test func aLossInOneYearShowsInThatYearOnly() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        site.capacity = { year, _ in year == 2025 ? 0.9 : 1 }
        let result = try Self.compute(
            Self.samples(site), Self.place(Self.eastWest), cache: SolarHealthCache(directory: Self.folder()))
        let factors = result.years.compactMap { $0.capacity?.site }
        #expect(factors.count == 3)
        #expect(abs(factors[0] - 1) < 0.02)
        #expect(abs(factors[1] - 0.9) < 0.02)
        #expect(abs(factors[2] - 1) < 0.02)
    }

    @Test func monthsWithEnoughClearDaysGetTheirOwnFactor() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        site.capacity = { _, month in month == 7 ? 0.93 : 1 }
        let result = try Self.compute(
            Self.samples(site, years: 2025 ... 2025), Self.place(Self.eastWest),
            cache: SolarHealthCache(directory: Self.folder()))
        let months = try #require(result.years.first?.months)
        #expect(months.count >= 8)
        let july = try #require(months.first { $0.month == 7 })
        #expect(abs(july.capacity.site - 0.93) < 0.03)
        let june = try #require(months.first { $0.month == 6 })
        #expect(abs(june.capacity.site - 1) < 0.03)
    }
}
