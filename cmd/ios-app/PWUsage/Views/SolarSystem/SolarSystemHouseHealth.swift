import Foundation

/// Interactive scrubber state for inspecting shading, soiling and aging on the house model.
struct SolarHouseHealthState: Equatable, Sendable {
    var season: SolarSeason
    /// Local solar hour of day (`6.0 ... 20.0`, where `12.0` is solar noon).
    var hourOfDay: Double
    /// Selected year on the aging scrubber; `nil` selects the latest available year.
    var selectedYear: Int?

    init(
        season: SolarSeason? = nil,
        hourOfDay: Double = 12.0,
        selectedYear: Int? = nil,
        latitude: Double = 40.0,
        now: Date = .now
    ) {
        if let season {
            self.season = season
        } else {
            let month = Calendar(identifier: .gregorian).component(.month, from: now)
            self.season = SolarSeason.of(month: month, latitude: latitude)
        }
        self.hourOfDay = hourOfDay
        self.selectedYear = selectedYear
    }
}

/// Per-face shading, dirt tint and aging opacity derived from `SolarHealthResult` and `SolarHealthReport`.
struct SolarHouseHealthOverlay: Equatable, Sendable {
    let sunVector: SIMD3<Double>
    let sunAzimuth: Double
    let sunElevation: Double
    let isSunShaded: Bool
    let dirtAmount: Double
    let yearFactor: Double?
    let directionFactors: [SolarHealthCapacity.Direction]

    init(
        report: SolarHealthReport?,
        result: SolarHealthResult?,
        state: SolarHouseHealthState,
        latitude: Double,
        longitude: Double,
        now: Date = .now
    ) {
        let currentYear = Calendar(identifier: .gregorian).component(.year, from: now)
        let latestYear = result?.years.last?.year ?? report?.changeOverTime.years.last?.year
        let effectiveYear = state.selectedYear ?? latestYear ?? currentYear

        let sun = Self.sunSample(
            season: state.season, year: effectiveYear, hourOfDay: state.hourOfDay,
            latitude: latitude, longitude: longitude)
        sunAzimuth = sun.azimuth
        sunElevation = sun.elevation
        let azRad = sun.azimuth * .pi / 180
        let elRad = sun.elevation * .pi / 180
        sunVector = SIMD3(sin(azRad) * cos(elRad), cos(azRad) * cos(elRad), sin(elRad))

        let shadeMask = Self.shadeMask(for: state.season, year: effectiveYear, in: result)
        isSunShaded = sun.elevation > 0 && (shadeMask?.shaded(azimuth: sun.azimuth, elevation: sun.elevation) ?? false)

        let isLatestYear = latestYear == nil || effectiveYear == latestYear
        if isLatestYear, report?.dirtLevel.isActive == true {
            let loss = report?.dirtLevel.currentLossPercent ?? 5.0
            dirtAmount = min(max(loss / 15.0, 0.25), 0.75)
        } else {
            dirtAmount = 0
        }

        if let yearData = result?.years.first(where: { $0.year == effectiveYear }) {
            yearFactor = yearData.capacity?.site
            directionFactors = yearData.capacity?.directions ?? []
        } else {
            yearFactor = report?.changeOverTime.years.first(where: { $0.year == effectiveYear })?.factor
            directionFactors = []
        }
    }

    /// True when the site's learned shade mask blocks the sun and this face is oriented toward the sun.
    func isFaceShaded(normal: SIMD3<Double>) -> Bool {
        isSunShaded && sunElevation > 0 && (normal * sunVector).sum() > 0
    }

    /// Fitted factor for a roof face at `azimuth` in the selected year, falling back to the site factor.
    func factor(forAzimuth azimuth: Double) -> Double? {
        if let closest = directionFactors.min(by: {
            SolarSystemHouse.angleBetween(azimuth, $0.azimuth)
                < SolarSystemHouse.angleBetween(azimuth, $1.azimuth)
        }) {
            return closest.factor
        }
        return yearFactor
    }

    /// Panel opacity for a roof face at `azimuth`, fading as fitted capacity declines across years.
    func panelOpacity(forAzimuth azimuth: Double) -> Double {
        guard let fitted = factor(forAzimuth: azimuth) else { return 1.0 }
        return min(max(fitted, 0.35), 1.0)
    }

    /// Sun position from `layoutSun` for a representative day in `season` and local solar `hourOfDay`.
    static func sunSample(
        season: SolarSeason, year: Int, hourOfDay: Double, latitude: Double, longitude: Double
    ) -> LayoutSunSample {
        let month = representativeMonth(for: season, latitude: latitude)
        let utcHour = hourOfDay - longitude / 15.0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 21
        components.hour = 0
        components.minute = 0
        components.second = 0
        let midnight = calendar.date(from: components) ?? Date(timeIntervalSince1970: 0)
        let date = midnight.addingTimeInterval(utcHour * 3600)
        return layoutSun(at: date, latitude: latitude, longitude: longitude)
    }

    /// End of `year` in UTC, so `ManualSolarLayout.houseGroups(detected:on:)` includes systems installed by `year`.
    static func endOfYearDate(year: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        let components = DateComponents(year: year, month: 12, day: 31, hour: 23, minute: 59, second: 59)
        return calendar.date(from: components) ?? .now
    }

    /// Formats a solar hour (`6.0 ... 20.0`) as a localized time string using `FormatStyle`.
    static func formatHour(_ hourOfDay: Double) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let today = calendar.startOfDay(for: .now)
        let date = today.addingTimeInterval(hourOfDay * 3600)
        return date.formatted(date: .omitted, time: .shortened)
    }

    private static func shadeMask(for season: SolarSeason, year: Int, in result: SolarHealthResult?) -> ShadeMask? {
        guard let result else { return nil }
        if let exact = result.years.first(where: { $0.year == year })?
            .shade.first(where: { $0.season == season })?
            .map.mask {
            return exact
        }
        return result.years.reversed()
            .compactMap { $0.shade.first(where: { $0.season == season })?.map.mask }
            .first
    }

    private static func representativeMonth(for season: SolarSeason, latitude: Double) -> Int {
        let northernMonth: Int = switch season {
        case .winter: 12
        case .spring: 3
        case .summer: 6
        case .autumn: 9
        }
        guard latitude < 0 else { return northernMonth }
        return ((northernMonth + 5) % 12) + 1
    }
}
