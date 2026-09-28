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

    static let unavailableNotePrefix = "Solar forecast unavailable — using tariff and balance data."

    static func overlay(
        enhancement: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        failure: SolarForecastRefreshFailure?,
        result: LoadTimingForecastEstimator.Result,
        forecastFetchedAt: Date?,
        contextAsOf: Date?,
        currencyCode: String,
        timeZone: String,
        now: Date
    ) -> Overlay {
        if enhancement == .enhanced, connection == .ready, let comparison = result.comparison,
           comparison.costNow.isFinite, comparison.recommendedCost.isFinite,
           comparison.savings.isFinite, comparison.estimatedSolarContribution.isFinite {
            return Overlay(
                isForecastAware: true,
                enhanced: enhancedSection(comparison, forecastFetchedAt: forecastFetchedAt,
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
                       failure: failure, result: result),
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
            let alternative = comparison.bestAlternativeSavings
            if alternative > 0 {
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
        failure: SolarForecastRefreshFailure?,
        result: LoadTimingForecastEstimator.Result
    ) -> String? {
        // No key on this device means there is nothing to explain.
        guard connection != .notConnected else { return nil }
        switch connection {
        case .awaitingArraySelection:
            return "Choose your solar arrays to add a forecast. Your estimate below already works without it."
        case .ready:
            break
        case .notConnected:
            return nil
        }
        if enhancement == .loadingWithBasic {
            return "Checking your solar forecast. Your estimate below already works without it."
        }
        // A load that needs no energy has nothing to forecast.
        if result.unavailableReason == .noEnergyNeeded { return nil }
        return failureNote(failure)
    }

    private static func failureNote(_ failure: SolarForecastRefreshFailure?) -> String {
        switch failure {
        case .unauthorized:
            return "\(unavailableNotePrefix) Solcast rejected the saved key. Retry from Solar forecast settings."
        case .rateLimited:
            return "\(unavailableNotePrefix) Today's request allowance is used up. Retry later today."
        case .requestFailed:
            return "\(unavailableNotePrefix) Solcast could not be reached. Retry when you have a connection."
        case .invalidForecast:
            return "\(unavailableNotePrefix) An array returned no usable forecast. Retry the array selection or refresh."
        case .storageFailure, .cleanupFailure:
            return "\(unavailableNotePrefix) Saved forecast data could not be used. Retry a refresh."
        case nil:
            return "\(unavailableNotePrefix) The forecast was too old or incomplete to use. Retry a refresh."
        }
    }
}
