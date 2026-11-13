import Foundation

/// Capacity of one period against the reference: 1.00 is a system making what the reference model says.
struct SolarHealthCapacity: Codable, Equatable, Sendable {
    /// A factor for faces pointing one way. A shared factor sits at the dominant direction.
    struct Direction: Codable, Equatable, Sendable {
        let azimuth: Double
        let factor: Double
    }

    let site: Double
    /// One entry per direction where the fit could separate the faces, otherwise one shared entry.
    let directions: [Direction]
    /// Clear days behind the fit.
    let clearDays: Int
}

struct SolarHealthMonth: Codable, Equatable, Sendable {
    let month: Int
    let capacity: SolarHealthCapacity
}

enum SolarSeason: String, Codable, CaseIterable, Sendable {
    case winter, spring, summer, autumn

    /// Winter is December to February of the same calendar year; seasons swap south of the equator.
    static func of(month: Int, latitude: Double) -> SolarSeason {
        let northern: SolarSeason
        switch month {
        case 3 ... 5: northern = .spring
        case 6 ... 8: northern = .summer
        case 9 ... 11: northern = .autumn
        default: northern = .winter
        }
        guard latitude < 0 else { return northern }
        switch northern {
        case .winter: return .summer
        case .spring: return .autumn
        case .summer: return .winter
        case .autumn: return .spring
        }
    }
}

/// A learned `ShadeMask`, in a form that survives a JSON file (horizons hold -infinity where nothing was learned).
struct SolarShadeMap: Codable, Equatable, Sendable {
    let horizon: [Double]
    /// `[azimuth, elevation]` of each hot bin.
    let hotBins: [[Double]]
    let observedBins: [Bool]?

    init(_ mask: ShadeMask) {
        horizon = mask.horizon
        hotBins = mask.hotBins.map { [$0.azimuth, $0.elevation] }
        observedBins = mask.observedBins
    }

    var mask: ShadeMask {
        ShadeMask(
            horizon: horizon,
            hotBins: hotBins.map { ShadeHotBin(azimuth: $0[0], elevation: $0[1]) },
            observedBins: observedBins ?? [])
    }
}

struct SolarSeasonShade: Codable, Equatable, Sendable {
    let season: SolarSeason
    let map: SolarShadeMap
    let clearDays: Int
}

/// Actual over reference energy on one clear day, with the night-gap-free rows both sides share.
struct SolarDailyRatio: Codable, Equatable, Sendable {
    /// Site-local `yyyy-MM-dd`.
    let day: String
    let ratio: Double
    /// Clear-day reference energy (kWh) and measured energy (kWh) on those shared rows.
    let expectedKwh: Double?
    let actualKwh: Double?

    init(day: String, ratio: Double, expectedKwh: Double? = nil, actualKwh: Double? = nil) {
        self.day = day
        self.ratio = ratio
        self.expectedKwh = expectedKwh
        self.actualKwh = actualKwh
    }
}

/// Everything the health pass derives from one calendar year. Derived data: cached per device, never synced.
struct SolarHealthYear: Codable, Equatable, Sendable {
    let year: Int
    /// What this was computed from (reference, location, detector, data); a cached year is used only when it matches.
    var key: String
    let clearDays: Int
    let capacity: SolarHealthCapacity?
    let months: [SolarHealthMonth]
    let shade: [SolarSeasonShade]
    let dailyRatios: [SolarDailyRatio]
    let hasClipping: Bool

    init(
        year: Int,
        key: String,
        clearDays: Int,
        capacity: SolarHealthCapacity?,
        months: [SolarHealthMonth],
        shade: [SolarSeasonShade],
        dailyRatios: [SolarDailyRatio],
        hasClipping: Bool = false
    ) {
        self.year = year
        self.key = key
        self.clearDays = clearDays
        self.capacity = capacity
        self.months = months
        self.shade = shade
        self.dailyRatios = dailyRatios
        self.hasClipping = hasClipping
    }

    /// The same year with every factor and ratio divided by `scale`.
    /// When `expectedDailyKwh` is provided (for clipped sites), it supplies pre-clipping scaled energy.
    func scaled(by scale: Double, expectedDailyKwh: [String: Double]? = nil) -> SolarHealthYear {
        guard scale > 0, scale != 1 else { return self }
        func divide(_ capacity: SolarHealthCapacity) -> SolarHealthCapacity {
            SolarHealthCapacity(
                site: capacity.site / scale,
                directions: capacity.directions.map { .init(azimuth: $0.azimuth, factor: $0.factor / scale) },
                clearDays: capacity.clearDays)
        }
        return SolarHealthYear(
            year: year, key: key, clearDays: clearDays, capacity: capacity.map(divide),
            months: months.map { SolarHealthMonth(month: $0.month, capacity: divide($0.capacity)) },
            shade: shade,
            dailyRatios: dailyRatios.map {
                SolarDailyRatio(
                    day: $0.day, ratio: $0.ratio / scale,
                    expectedKwh: expectedDailyKwh?[$0.day] ?? $0.expectedKwh.map { $0 * scale },
                    actualKwh: $0.actualKwh)
            },
            hasClipping: hasClipping)
    }
}

/// The health pass's output, oldest year first, ready for classification.
struct SolarHealthResult: Equatable, Sendable {
    let reference: SolarHealthReference
    /// With a detected reference, years are scaled so the best year is 1.00;
    /// with a manual one, 1.00 is the nameplate model.
    let years: [SolarHealthYear]
    let referenceScale: Double
    /// The years this run computed; the rest came from the cache.
    let recomputedYears: [Int]
}
