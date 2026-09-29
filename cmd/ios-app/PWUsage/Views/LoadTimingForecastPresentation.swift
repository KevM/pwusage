import Foundation

/// Forecast-aware presentation is strictly additive.
///
/// It contributes an enhanced section and at most one small informational note.
/// It deliberately has no field capable of carrying a basic total, breakdown, or
/// selected profile, so no forecast state can overwrite the estimate the existing
/// estimator already produced.
enum LoadTimingForecastPresentation {
    struct Enhanced: Equatable {
        let headline: String
        let costNow: String
        let recommendedCost: String
        /// Present only when waiting is genuinely worth doing. Absent states must
        /// not read as a promise.
        let savings: String?
        let window: String
        let solarContribution: String
        let horizon: String
        let sourceAges: [String]
    }

    struct Overlay: Equatable {
        let isForecastAware: Bool
        let enhanced: Enhanced?
        let note: String?
        let detail: String

        /// Every user-visible string, in reading order. Used to assert that a
        /// fallback state leaks no forecast-derived value.
        var allText: [String] {
            var parts: [String] = []
            if let enhanced {
                parts.append(enhanced.headline)
                parts.append(enhanced.costNow)
                parts.append(enhanced.recommendedCost)
                if let savings = enhanced.savings { parts.append(savings) }
                parts.append(enhanced.window)
                parts.append(enhanced.solarContribution)
                parts.append(enhanced.horizon)
                parts.append(contentsOf: enhanced.sourceAges)
            }
            if let note { parts.append(note) }
            if !detail.isEmpty { parts.append(detail) }
            return parts
        }

        var accessibilityLabel: String {
            allText.joined(separator: ". ")
        }
    }

    /// Which card carries the forecast comparison, and for which load.
    enum Card: Equatable {
        case recommendation
        case explorer
    }

    struct Placement: Equatable {
        let card: Card
        let profile: LoadProfile
    }

    /// The forecast always attaches to a load the user can actually see, and
    /// appears exactly once. The basic recommendation is deliberately not a
    /// precondition: a surplus shortfall or stale observations must not hide the
    /// forecast, because comparing tomorrow's start times is most useful precisely
    /// when the basic layer cannot recommend anything.
    static func placement(
        recommendation: LoadTimingRecommendation,
        explicitExploredID: String?
    ) -> Placement? {
        let explored = recommendation.exploredProfile(explicitID: explicitExploredID)
        guard let profile = explored?.profile else { return nil }
        let card: Card = recommendation.suggested?.profile.id == profile.id ? .recommendation : .explorer
        return Placement(card: card, profile: profile)    }

    static let unavailableNotePrefix = "Solar forecast unavailable — using tariff and balance data."
    /// Matches `SolarForecastStore.recommendationFreshness`. Data older than this
    /// may be shown as stale, but must not produce a new recommendation.
    static let maximumForecastAge: TimeInterval = 6 * 60 * 60

    static func overlay(
        enhancement: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        cause: SolarForecastUnavailableCause?,
        result: LoadTimingForecastEstimator.Result,
        forecastFetchedAt: Date?,
        contextAsOf: Date?,
        currencyCode: String,
        timeZone: String,
        now: Date
    ) -> Overlay {
        if enhancement == .enhanced, connection == .ready, let comparison = result.comparison,
           let fetchedAt = forecastFetchedAt, now.timeIntervalSince(fetchedAt) <= maximumForecastAge,
           comparison.costNow.isFinite, comparison.recommendedCost.isFinite,
           comparison.savings.isFinite, comparison.estimatedSolarContribution.isFinite {
            return Overlay(
                isForecastAware: true,
                enhanced: enhancedSection(comparison, forecastFetchedAt: fetchedAt,
                                          contextAsOf: contextAsOf, currencyCode: currencyCode,
                                          timeZone: timeZone, now: now),
                note: nil,
                detail: "This estimate assumes typical household and battery behavior from your history. "
                    + "Your final bill cost may differ from this estimate."
            )
        }
        return Overlay(
            isForecastAware: false,
            enhanced: nil,
            note: note(enhancement: enhancement, connection: connection,
                       cause: cause, result: result),
            detail: ""
        )
    }

    private static func enhancedSection(
        _ comparison: LoadTimingForecastEstimator.Comparison,
        forecastFetchedAt: Date?,
        contextAsOf: Date?,
        currencyCode: String,
        timeZone: String,
        now: Date
    ) -> Enhanced {
        let money: (Double) -> String = { DashboardPresentation.currency($0, code: currencyCode) }
        let clock: (Date) -> String = {
            DashboardPresentation.date($0, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
        }
        let startNow = comparison.recommendedStart <= comparison.horizonStart
        let costNow = "Start now: \(money(comparison.costNow))"
        let recommendedCost = startNow
            ? costNow
            : "Start at \(clock(comparison.recommendedStart)): \(money(comparison.recommendedCost))"

        let headline: String
        let savings: String?
        if startNow {
            // Anything below one minor unit renders as $0.00 and reads as noise.
            let alternative = comparison.bestAlternativeSavings
            if alternative > LoadTimingForecastEstimator.currencyMinorUnit(currencyCode) {
                headline = "Start now — waiting would save about \(money(alternative)), which is not worth delaying"
            } else {
                headline = "Start now — no cheaper start was found"
            }
            savings = nil
        } else {
            headline = "Waiting could save an estimated \(money(comparison.savings))"
            savings = "Estimated savings \(money(comparison.savings))"
        }

        return Enhanced(
            headline: headline,
            costNow: costNow,
            recommendedCost: recommendedCost,
            savings: savings,
            window: "Runs \(clock(comparison.recommendedStart)) – \(clock(comparison.recommendedEnd))",
            solarContribution: "About \(comparison.estimatedSolarContribution.formatted(.number.precision(.fractionLength(1)))) kWh of this run could come from your solar",
            horizon: "Compared \(clock(comparison.horizonStart)) – \(clock(comparison.horizonEnd))",
            sourceAges: [
                "Solar forecast · \(DashboardPresentation.freshness(forecastFetchedAt, now: now, staleAfter: 6 * 60 * 60))",
                "Household pattern · \(DashboardPresentation.freshness(contextAsOf, now: now, staleAfter: 24 * 60 * 60))"
            ]
        )
    }

    private static func note(
        enhancement: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        cause: SolarForecastUnavailableCause?,
        result: LoadTimingForecastEstimator.Result
    ) -> String? {
        // No key on this device means there is nothing to explain.
        switch connection {
        case .notConnected:
            return nil
        case .awaitingArraySelection:
            return "Choose your solar arrays to add a forecast. Your estimate below already works without it."
        case .ready:
            break
        }
        if enhancement == .loadingWithBasic {
            return "Checking your solar forecast. Your estimate below already works without it."
        }
        // Name the actual blocker. A spent allowance or a stale balance is not a
        // Solcast failure, and telling the user to retry would be wrong.
        switch result.unavailableReason {
        case .none:
            break
        case .noEnergyNeeded:
            return nil
        case .staleBalance:
            return "\(unavailableNotePrefix) Energy observations are older than 30 minutes, so the solar comparison is paused."
        case .incompleteBalance:
            return "\(unavailableNotePrefix) Some billing-period balances are missing, so the solar comparison is paused."
        case .noFittingRun:
            return "\(unavailableNotePrefix) This load is longer than the search horizon. Try a smaller charge or a faster charging level."
        case .incompleteContext:
            return "\(unavailableNotePrefix) There is not enough household history yet to estimate expected usage."
        case .missingTariff:
            return "\(unavailableNotePrefix) An active tariff is needed before costs can be compared."
        case .incompleteCoverage, .invalidInput, .none:
            // These also stand in for "the view had nothing to evaluate", so the
            // device's own request bookkeeping is the better explanation.
            break
        }
        return causeNote(cause)
    }

    private static func causeNote(_ cause: SolarForecastUnavailableCause?) -> String {
        switch cause {
        case .unauthorized:
            return "\(unavailableNotePrefix) Solcast rejected the saved key. Retry from Solar forecast settings."
        case .rateLimited:
            return "\(unavailableNotePrefix) Solcast is limiting requests. Retry later today."
        case .requestFailed:
            return "\(unavailableNotePrefix) Solcast could not be reached. Retry when you have a connection."
        case .unknownResource:
            return "\(unavailableNotePrefix) Solcast does not recognise one of your Solar System IDs, "
                + "so that request counted as an attempt. Choose your arrays again in Solar forecast settings."
        case .invalidForecast:
            return "\(unavailableNotePrefix) An array returned no usable forecast. Retry the array selection or refresh."
        case .storageFailure, .cleanupFailure:
            return "\(unavailableNotePrefix) Saved forecast data could not be used. Retry a refresh."
        case .budgetExhausted:
            return "\(unavailableNotePrefix) This device has used its forecast allowance for today. Try again tomorrow."
        case .deferred:
            return "\(unavailableNotePrefix) Requests are paused until the daily limit resets. Retry tomorrow."
        case nil:
            return "\(unavailableNotePrefix) The forecast was too old or incomplete to use. Retry a refresh."
        }
    }
}
