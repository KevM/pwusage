import Foundation

enum LoadTimingPresentation {
    struct RecommendationMessage: Equatable {
        let title: String
        let detail: String
    }

    static let noResponseRecommendationMessage = RecommendationMessage(
        title: "Recommendation unavailable",
        detail: "The latest refresh failed and no saved bill data is available, "
            + "so no recommendation or job estimates can be shown."
    )
    /// "Model Y · 30% → 80%": the car's name, charge now and charge target, shown exactly as saved.
    static func carSummary(_ profile: LoadProfile) -> String? {
        guard profile.kind == .car, let settings = profile.carSettings else { return nil }
        return "\(profile.name) · \(percent(settings.initialStateOfCharge)) → \(percent(settings.targetStateOfCharge))"
    }

    static func carSummaryAccessibilityLabel(_ profile: LoadProfile) -> String? {
        guard profile.kind == .car, let settings = profile.carSettings else { return nil }
        return "\(profile.name), charge now \(percent(settings.initialStateOfCharge, word: true)), "
            + "charging to \(percent(settings.targetStateOfCharge, word: true))"
    }

    private static func percent(_ value: Double, word: Bool = false) -> String {
        let number = value.formatted(.number.precision(.fractionLength(0)))
        return word ? "\(number) percent" : "\(number)%"
    }

    static func profileChipTitle(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) {
            return "\(profile.name) · "
                + "\(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh battery"
        }
        return "\(profile.name) · \(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh"
    }

    static func profileChipAccessibilityLabel(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) {
            return "\(profile.name), "
                + "\(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours "
                + "to the battery, about "
                + "\(estimate.wallKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours "
                + "from the wall, Level \(settings.chargingLevel == .level1 ? "1" : "2")"
        }
        return "\(profile.name), "
            + "\(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours, "
            + "\(profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours"
    }

    static func sourceTimeSummary(_ energyDataThrough: Date?, timeZone: String) -> String {
        let time = energyDataThrough.map {
            DashboardPresentation.date($0, timeZoneIdentifier: timeZone,
                                       dateStyle: .medium, timeStyle: .short)
        } ?? "unavailable"
        return "Energy usage through \(time)"
    }

    /// One hour is deliberate, so the verdict and this label age out on the same
    /// tick. It is *not* the same policy as
    /// `LoadTimingForecastEstimator.Projection.maximumBalanceAge` (30 minutes for
    /// a forecast without grid history), which gates whether a forecast may be
    /// produced at all: a forecast that policy already rejects can keep being
    /// described here for up to another 30 minutes. The two are separate on
    /// purpose — one is "can we still trust the basic estimate", the other is
    /// "may we forecast".
    static func sourceStatus(isUnavailable: Bool, energyDataThrough: Date?, now: Date = .now) -> String {
        let freshness = DashboardPresentation.freshness(energyDataThrough, now: now, staleAfter: 60 * 60)
        return isUnavailable ? "Refresh unavailable · \(freshness.lowercased())" : freshness
    }

    /// A minute timeline's date is the start of the minute, earlier than a source
    /// fetched since; measuring from the later of it and the real clock keeps that
    /// source from reading as in the future until the next tick.
    static func sourceStatus(
        isUnavailable: Bool,
        energyDataThrough: Date?,
        timelineDate: Date,
        clock: Date = .now
    ) -> String {
        sourceStatus(isUnavailable: isUnavailable, energyDataThrough: energyDataThrough, now: max(timelineDate, clock))
    }
}
