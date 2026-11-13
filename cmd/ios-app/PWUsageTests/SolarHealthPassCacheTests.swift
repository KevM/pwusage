import Foundation
@testable import PWUsage
import Testing

/// What the health pass recomputes and what it takes from the cache.
@Suite("Solar health pass cache")
struct SolarHealthPassCacheTests {
    private static let planes = SolarHealthPassTests.eastWest
    private static let scope = SolarHealthPassTests.scope

    private static func samples() -> [(timestamp: Date, solarWh: Double)] {
        let site = SyntheticSolarSite(planes: planes)
        return site.samples(
            from: DateComponents(year: 2025, month: 6, day: 1),
            through: DateComponents(year: 2025, month: 6, day: 24))
            + site.samples(
                from: DateComponents(year: 2026, month: 4, day: 1),
                through: DateComponents(year: 2026, month: 4, day: 24))
    }

    @Test func aNormalRunRecomputesOnlyTheCurrentYear() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let samples = Self.samples()
        let place = try SolarHealthPassTests.place(Self.planes)
        let first = try SolarHealthPassTests.compute(samples, place, cache: cache)
        #expect(first.recomputedYears == [2025, 2026])
        let second = try SolarHealthPassTests.compute(samples, place, cache: cache)
        #expect(second.recomputedYears == [2026])
        #expect(second.years == first.years)
    }

    @Test func changingTheManualLayoutRecomputesEveryYear() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let samples = Self.samples()
        _ = try SolarHealthPassTests.compute(samples, SolarHealthPassTests.place(Self.planes), cache: cache)
        let changed = [SolarHealthPlane.face(90, kw: 3), .face(270, kw: 3.4)]
        let result = try SolarHealthPassTests.compute(samples, SolarHealthPassTests.place(changed), cache: cache)
        #expect(result.recomputedYears == [2025, 2026])
    }

    @Test func changingTheLocationRecomputesEveryYear() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let samples = Self.samples()
        let place = try SolarHealthPassTests.place(Self.planes)
        _ = try SolarHealthPassTests.compute(samples, place, cache: cache)
        let moved = SolarHealthYearFit.Place(
            reference: place.reference, latitude: place.latitude + 0.5, longitude: place.longitude,
            timeZone: place.timeZone)
        let result = try SolarHealthPassTests.compute(samples, moved, cache: cache)
        #expect(result.recomputedYears == [2025, 2026])
    }

    @Test func moreHistoryInACompletedYearRecomputesIt() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let samples = Self.samples()
        let place = try SolarHealthPassTests.place(Self.planes)
        _ = try SolarHealthPassTests.compute(samples, place, cache: cache)
        // Loading older history fills in the first days of June 2025.
        let partial = samples.filter { $0.timestamp >= Date(timeIntervalSince1970: 1_749_100_000) }
        _ = try SolarHealthPassTests.compute(partial, place, cache: cache)
        let full = try SolarHealthPassTests.compute(samples, place, cache: cache)
        #expect(full.recomputedYears.contains(2025))
    }

    @Test func editingASampleValueInACompletedYearRecomputesIt() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let samples = Self.samples()
        let place = try SolarHealthPassTests.place(Self.planes)
        _ = try SolarHealthPassTests.compute(samples, place, cache: cache)
        var corrected = samples
        let mid = corrected.count / 4
        corrected[mid] = (corrected[mid].timestamp, corrected[mid].solarWh + 25)
        let result = try SolarHealthPassTests.compute(corrected, place, cache: cache)
        #expect(result.recomputedYears == [2025, 2026])
    }

    @Test func aDamagedCacheFileIsRecomputedNotTrusted() throws {
        let folder = SolarHealthPassTests.folder()
        let cache = SolarHealthCache(directory: folder)
        let samples = Self.samples()
        let place = try SolarHealthPassTests.place(Self.planes)
        _ = try SolarHealthPassTests.compute(samples, place, cache: cache)
        let site = folder.appendingPathComponent(Self.scope.storageHash)
        let file = site.appendingPathComponent("2025.json")
        try Data("not json".utf8).write(to: file)
        let result = try SolarHealthPassTests.compute(samples, place, cache: cache)
        #expect(result.recomputedYears.contains(2025))
        #expect(cache.year(2025, scope: Self.scope) != nil)
    }

    @Test func cachedYearsKeepShadeHorizonsThatAreInfinite() throws {
        let cache = SolarHealthCache(directory: SolarHealthPassTests.folder())
        let mask = SolarShadeMap(
            ShadeMask(horizon: [-.infinity, 12.5], hotBins: [ShadeHotBin(azimuth: 20, elevation: 5)]))
        let year = SolarHealthYear(
            year: 2024, key: "k", clearDays: 9, capacity: nil, months: [],
            shade: [SolarSeasonShade(season: .summer, map: mask, clearDays: 9)], dailyRatios: [])
        try cache.store(year, scope: Self.scope)
        #expect(cache.year(2024, scope: Self.scope) == year)
        try cache.remove(scope: Self.scope)
        #expect(cache.year(2024, scope: Self.scope) == nil)
    }

    @Test func cancellationStopsThePass() throws {
        struct Stop: Error {}
        #expect(throws: Stop.self) {
            try SolarHealthPass.compute(
                samples: Self.samples(), place: SolarHealthPassTests.place(Self.planes),
                context: SolarHealthPass.Context(
                    scope: Self.scope, cache: SolarHealthCache(directory: SolarHealthPassTests.folder()),
                    now: SolarHealthPassTests.now),
                checkCancellation: { throw Stop() })
        }
    }
}
