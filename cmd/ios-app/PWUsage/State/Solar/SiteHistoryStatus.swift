import Foundation

/// What the phone holds for a site, besides its onboarding progress.
struct SiteHistoryStoredState: Equatable, Sendable {
    var result: DetectedSolarLayout?
    var location: SolarHomeLocation?
    /// Site-local days holding any reading.
    var days: [String] = []
    var isRevealOwed = false
}

/// The saved onboarding state of one site and what the phone holds for it, as the Solar System
/// screen and banner show it. Every count comes from the phone's stored history and the latest
/// clear-day pass, never from the onboarding position, so a resync cannot make them disagree.
struct SiteHistoryStatus: Equatable, Sendable {
    enum LocationState: Equatable, Sendable {
        case none
        /// Seeded from a ZIP code or town.
        case estimated
        case exact
    }

    /// A stored day; `type` is nil until a clear-day pass has sorted it.
    struct Day: Equatable, Sendable {
        let day: String
        let type: SolarDayType?
    }

    enum Wedge: Equatable, Sendable {
        /// No fit yet: the width only reflects the clear-day count.
        case stylized(clearDays: Int)
        /// The largest plane's 90% azimuth range.
        case fitted(azimuthRange90: [Double])
    }

    let scope: SolarForecastSiteScope
    /// Nil until the first slice is saved.
    let progress: SiteHistoryOnboardingProgress?
    /// The account's Tesla retry deadline, possibly already past.
    let throttledUntil: Date?
    /// The stored detection result, and its layout when the forecast can use it.
    let result: DetectedSolarLayout?
    let layout: SolarLayout?
    let location: LocationState
    let latitude: Double?
    /// Stored days with any reading, oldest first.
    let days: [Day]
    let producingDays: Int
    let clearDays: Int
    let wedge: Wedge
    /// This phone found the layout and nobody has seen it yet; never true without a layout to show.
    let isRevealOwed: Bool

    init(
        scope: SolarForecastSiteScope, progress: SiteHistoryOnboardingProgress?, throttledUntil: Date?,
        result: DetectedSolarLayout? = nil, homeLocation: SolarHomeLocation? = nil, storedDays: [String] = [],
        ledger: SiteHistoryDayLedger? = nil, isRevealOwed: Bool = false
    ) {
        self.scope = scope
        self.progress = progress
        self.throttledUntil = throttledUntil
        self.result = result
        layout = result.flatMap { SolarLayoutDetector.forecastLayout($0, detectedAt: .distantPast) }
        location = switch homeLocation?.source {
        case nil: .none
        case .estimated: .estimated
        default: .exact
        }
        self.isRevealOwed = isRevealOwed && layout != nil
        latitude = homeLocation?.latitude
        let types = ledger?.dayTypes ?? [:]
        days = storedDays.sorted().map { Day(day: $0, type: types[$0]) }
        producingDays = days.count { $0.type == .clear || $0.type == .cloudy }
        clearDays = days.count { $0.type == .clear }
        // The stored result is the latest fit, whether onboarding or the ordinary schedule ran it.
        if let largest = result?.planes.max(by: { $0.effectiveKw < $1.effectiveKw }) {
            wedge = .fitted(azimuthRange90: largest.azimuthRange90)
        } else if let range = ledger?.checkpoint?.azimuthRange90 {
            wedge = .fitted(azimuthRange90: range)
        } else {
            wedge = .stylized(clearDays: clearDays)
        }
    }

    var downloadedDays: Int { days.count }
    var hasUsableLayout: Bool { layout != nil }

    /// Whether history is still loading for a site without a usable layout. A site that has one
    /// only loads quietly, which is not worth announcing.
    var isLoadingForForecasting: Bool {
        progress?.phase == .active && !hasUsableLayout
    }
}
