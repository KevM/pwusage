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
        _ site: SyntheticSolarSite, years: ClosedRange<Int> = 2024 ... 2026,
        monthRange: ClosedRange<Int> = 6 ... 6, dayRange: ClosedRange<Int> = 1 ... 24
    ) -> [(timestamp: Date, solarWh: Double)] {
        years.flatMap { year in
            site.samples(
                from: DateComponents(year: year, month: monthRange.lowerBound, day: dayRange.lowerBound),
                through: DateComponents(year: year, month: monthRange.upperBound, day: dayRange.upperBound))
        }
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
            samples: samples, place: place, context: SolarHealthPass.Context(scope: scope, cache: cache, now: now),
            checkCancellation: {})
    }

    @Test func healthySiteGivesAFactorNearOneEveryYear() throws {
        let samples = Self.samples(SyntheticSolarSite(planes: Self.eastWest))
        let result = try Self.compute(
            samples, Self.place(Self.eastWest), cache: SolarHealthCache(directory: Self.folder()))
        #expect(result.years.map(\.year) == [2024, 2025, 2026])
        for year in result.years {
            let capacity = try #require(year.capacity, "\(year.year) capacity")
            #expect(abs(capacity.site - 1) < 0.02, "\(year.year) site factor \(capacity.site)")
            #expect(capacity.clearDays >= 10, "\(year.year) clear days")
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
        let samples = Self.samples(site, years: 2025 ... 2025, monthRange: 6 ... 7, dayRange: 1 ... 28)
        let result = try Self.compute(
            samples, Self.place(Self.eastWest),
            cache: SolarHealthCache(directory: Self.folder()))
        let months = try #require(result.years.first?.months)
        #expect(months.count == 2)
        let july = try #require(months.first { $0.month == 7 })
        #expect(abs(july.capacity.site - 0.93) < 0.03)
        let june = try #require(months.first { $0.month == 6 })
        #expect(abs(june.capacity.site - 1) < 0.03)
    }

    @Test func seasonalShadeLearnsHorizonInShadedSeasonOnly() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        site.overcastEvery = 100
        site.shaded = { day, azimuth, elevation in
            day.hasPrefix("2025-07-") && azimuth >= 80 && azimuth <= 160 && elevation < 30
        }
        let samples = site.samples(
            from: DateComponents(year: 2025, month: 7, day: 1),
            through: DateComponents(year: 2025, month: 7, day: 30))
            + site.samples(
                from: DateComponents(year: 2025, month: 10, day: 1),
                through: DateComponents(year: 2025, month: 10, day: 16))
        let result = try Self.compute(
            samples, Self.place(Self.eastWest, site: site), cache: SolarHealthCache(directory: Self.folder()))
        let shade = try #require(result.years.first?.shade)
        let summer = try #require(shade.first { $0.season == .summer })
        let autumn = try #require(shade.first { $0.season == .autumn })
        #expect(summer.map.mask.shaded(azimuth: 85, elevation: 18))
        #expect(!autumn.map.mask.shaded(azimuth: 85, elevation: 18))
    }

    @Test func soilingDropsAndRecoversDailyRatios() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        site.overcastEvery = 100
        let dirtyDays: Set<String> = ["2025-06-08", "2025-06-09", "2025-06-10", "2025-06-11"]
        site.dayScale = { dirtyDays.contains($0) ? 0.94 : 1.0 }
        let samples = Self.samples(site, years: 2025 ... 2025, monthRange: 6 ... 6, dayRange: 1 ... 18)
        let result = try Self.compute(
            samples, Self.place(Self.eastWest, site: site), cache: SolarHealthCache(directory: Self.folder()))
        let ratios = try #require(result.years.first?.dailyRatios)
        let dirty = ratios.filter { dirtyDays.contains($0.day) }
        #expect(dirty.count == dirtyDays.count)
        for item in dirty { #expect(abs(item.ratio - 0.94) < 0.02, "\(item.day) ratio \(item.ratio)") }
        let recovered = try #require(ratios.first { $0.day == "2025-06-14" })
        #expect(abs(recovered.ratio - 1.0) < 0.02)
    }

    @Test func installDateStepsKeepHealthyFactorAcrossExpansion() throws {
        let eastOnly = [SolarHealthPlane.face(90, kw: 3)]
        let stepDate = DateComponents(
            calendar: Calendar(identifier: .gregorian), timeZone: SyntheticSolarSite(planes: eastOnly).timeZone,
            year: 2025, month: 6, day: 15).date ?? .now
        let siteBefore = SyntheticSolarSite(planes: eastOnly)
        let siteAfter = SyntheticSolarSite(planes: Self.eastWest)
        let samples = siteBefore.samples(
            from: DateComponents(year: 2024, month: 6, day: 1),
            through: DateComponents(year: 2024, month: 6, day: 20))
            + siteBefore.samples(
                from: DateComponents(year: 2025, month: 6, day: 1),
                through: DateComponents(year: 2025, month: 6, day: 14))
            + siteAfter.samples(
                from: DateComponents(year: 2025, month: 6, day: 15),
                through: DateComponents(year: 2025, month: 6, day: 30))
        let layout = manualLayout(
            for: Self.eastWest, installDates: [Date(timeIntervalSince1970: 1_700_000_000), stepDate])
        let result = try Self.compute(
            samples, Self.place(Self.eastWest, layout: layout), cache: SolarHealthCache(directory: Self.folder()))
        for year in result.years {
            let factor = try #require(year.capacity?.site, "\(year.year) capacity")
            #expect(abs(factor - 1) < 0.03, "\(year.year) factor \(factor)")
        }
    }

    @Test func detectedReferenceNormalisesBestYearToOne() throws {
        var site = SyntheticSolarSite(planes: Self.eastWest)
        site.capacity = { year, _ in year == 2025 ? 0.85 : 1.0 }
        let samples = Self.samples(site, years: 2024 ... 2025, monthRange: 6 ... 6, dayRange: 1 ... 20)
        // Deliberately wrong effectiveKw in the detected layout; normalisation should anchor best year at 1.00.
        let detected = DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [],
            planes: [
                .init(
                    azimuth: 90, tilt: 25, dcKwp: 3, effectiveKw: 2.0,
                    azimuthRange90: [85, 95], tiltRange90: [20, 30]),
                .init(
                    azimuth: 270, tilt: 25, dcKwp: 3, effectiveKw: 2.0,
                    azimuthRange90: [265, 275], tiltRange90: [20, 30])
            ],
            acClipKw: nil, historyDays: 200, clearDays: 50, firstDay: nil, lastDay: nil)
        let reference = try #require(SolarHealthReference(manual: nil, detected: detected))
        let place = SolarHealthYearFit.Place(
            reference: reference, latitude: site.latitude, longitude: site.longitude, timeZone: site.timeZone)
        let result = try Self.compute(samples, place, cache: SolarHealthCache(directory: Self.folder()))
        #expect(result.reference.source == .detected)
        #expect(abs(result.referenceScale - 1.5) < 0.04)
        let year2024 = try #require(result.years.first { $0.year == 2024 }?.capacity?.site)
        let year2025 = try #require(result.years.first { $0.year == 2025 }?.capacity?.site)
        #expect(abs(year2024 - 1.0) < 1e-9)
        #expect(abs(year2025 - 0.85) < 0.03)
    }
}

/// Ten-year synthetic run under `-O`, gated like `SolarLayoutDetectorYearParityTests`.
@Suite(
    "Solar health pass ten-year budget (opt-in)",
    .enabled(if: ProcessInfo.processInfo.environment["PWUSAGE_SOLAR_SLOW_PARITY"] == "1"))
struct SolarHealthPassBudgetTests {
    @Test func tenYearsFinishesWithinBudget() throws {
        let site = SyntheticSolarSite(planes: SolarHealthPassTests.eastWest)
        let samples = site.samples(
            from: DateComponents(year: 2017, month: 1, day: 1),
            through: DateComponents(year: 2026, month: 12, day: 28))
        let place = try SolarHealthPassTests.place(SolarHealthPassTests.eastWest, site: site)
        let started = ProcessInfo.processInfo.systemUptime
        let result = try SolarHealthPassTests.compute(
            samples, place, cache: SolarHealthCache(directory: SolarHealthPassTests.folder()))
        let seconds = ProcessInfo.processInfo.systemUptime - started
        print(String(format: "SOLAR_HEALTH_10Y_TIMING %.2f s", seconds))
        #expect(result.years.count == 10)
        #expect(seconds < 60, "10-year pass took \(seconds)s")
    }
}
