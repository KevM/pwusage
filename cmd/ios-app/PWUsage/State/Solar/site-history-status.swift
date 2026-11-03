import Foundation

/// The saved onboarding state of one site, as Settings and the tab accessory show it.
struct SiteHistoryStatus: Equatable, Sendable {
    let scope: SolarForecastSiteScope
    /// Nil until the first slice is saved.
    let progress: SiteHistoryOnboardingProgress?
    /// The account's Tesla retry deadline, possibly already past.
    let throttledUntil: Date?
    let hasUsableLayout: Bool

    /// Whether history is still loading for a site without a usable layout. A site that has one
    /// only loads its recent days, which is not worth announcing.
    var isLoadingForForecasting: Bool {
        progress?.phase == .active && !hasUsableLayout
    }
}
