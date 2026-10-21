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
        return Placement(card: card, profile: profile)
    }

    static let unavailableNotePrefix = "Solar forecast unavailable. Using your rate plan and bank data."
    /// Deliberately does not reuse `unavailableNotePrefix`: the forecast is
    /// available here, it just did not reach the disk.
    /// Shown when the device could not write its forecast state, which has two sites:
    /// the post-fetch persist (a forecast was fetched and could not be written) and
    /// the pre-fetch budget reservation (no request was made, and the request
    /// counter could not be written). The wording covers both — it says what failed
    /// and what the consequence is, not which of the two happened.
    ///
    /// The promise in the last sentence is load-bearing and is kept:
    /// `SolarForecastStore.dirtyScopes` records a write left pending by a failed
    /// persist, and the `.alreadyFresh` short-circuit attempts it before reporting
    /// the cache fresh. Do not "correct" this copy by removing the promise — the
    /// defect was never the wording, it was that nothing retried the write for three
    /// hours while the note said it would.
    static let saveFailureNote = "Forecast data could not be saved to this device, so it may not update. It will be retried on the next refresh."
    /// Deliberately does not reuse the "too old or incomplete" fallback, and does
    /// not use `unavailableNotePrefix` either: the forecast is present, and its age
    /// is unverifiable rather than too old. The batch is stamped with this device's
    /// own clock at fetch time (`SolarForecastStore.swift:503`), so a future-dated
    /// stamp means the clock has since moved backwards, not that the server sent
    /// the wrong time. Point at the clock, which the user can fix, the same way
    /// `contextInvalid` does for `asOf`.
    static let futureDatedForecastNote = "This solar forecast is timestamped later than this device's clock, so its age cannot be checked and it is not being used for now. Check this device's date and time, then pull down to refresh."
    /// Matches `SolarForecastStore.recommendationFreshness`. Data older than this
    /// may be shown as stale, but must not produce a new recommendation.
    static let maximumForecastAge: TimeInterval = 6 * 60 * 60

    static func overlay(
        enhancement: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        cause: SolarForecastUnavailableCause?,
        saveFailed: Bool = false,
        enhancementReason: SolarForecastEnhancementUnavailableReason? = nil,
        result: LoadTimingForecastEstimator.Result,
        forecastFetchedAt: Date?,
        contextAsOf: Date?,
        currencyCode: String,
        timeZone: String,
        now: Date
    ) -> Overlay {
        let forecastAge = forecastFetchedAt.map { now.timeIntervalSince($0) }
        if enhancement == .enhanced, connection == .ready, let comparison = result.comparison,
           let fetchedAt = forecastFetchedAt, let forecastAge,
           forecastAge >= 0, forecastAge <= maximumForecastAge,
           comparison.costNow.isFinite, comparison.recommendedCost.isFinite,
           comparison.savings.isFinite, comparison.estimatedSolarContribution.isFinite {
            return Overlay(
                isForecastAware: true,
                enhanced: enhancedSection(comparison, forecastFetchedAt: fetchedAt,
                                          contextAsOf: contextAsOf, currencyCode: currencyCode,
                                          timeZone: timeZone, now: now),
                note: saveFailed ? saveFailureNote : nil,
                detail: "This estimate assumes typical household and battery behavior from your history. "
                    + "Your final bill cost may differ from this estimate."
            )
        }
        // A negative age means the batch's stamp is ahead of this device's clock:
        // the stamp is this device's own clock as of fetch time, so the clock has
        // moved backwards since — see `futureDatedForecastNote`. The forecast is
        // present, so only the generic age fallback would misdescribe it — a
        // specific cause or reason below still names the real blocker, and is left
        // to do so.
        let forecastIsFutureDated = forecastAge.map { $0 < 0 } ?? false
        return Overlay(
            isForecastAware: false,
            enhanced: nil,
            note: note(enhancement: enhancement, connection: connection,
                       cause: cause, enhancementReason: enhancementReason, result: result,
                       forecastIsFutureDated: forecastIsFutureDated),
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
        // Both figures are the *marginal* cost of the load against the projected
        // household baseline, not the absolute cost of the energy involved. Say so
        // in the copy: rendered as a bare "$X" the near-zero case (the load is
        // served by already-paid-for stored surplus) reads as a total.
        let costNow = "Start now. Adds \(money(comparison.costNow)) to your projected bill"
        let recommendedCost = startNow
            ? costNow
            : "Start at \(clock(comparison.recommendedStart)). Adds \(money(comparison.recommendedCost)) to your projected bill"

        let headline: String
        let savings: String?
        if startNow {
            // Anything below one minor unit renders as $0.00 and reads as noise.
            let alternative = comparison.bestAlternativeSavings
            if alternative > LoadTimingForecastEstimator.currencyMinorUnit(currencyCode) {
                headline = "Start now. Waiting would save about \(money(alternative)), which is not worth delaying"
            } else {
                headline = "Start now. No cheaper start was found"
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
        enhancementReason: SolarForecastEnhancementUnavailableReason?,
        result: LoadTimingForecastEstimator.Result,
        forecastIsFutureDated: Bool
    ) -> String? {
        // No key on this device means there is nothing to explain.
        switch connection {
        case .checking, .notConnected:
            return nil
        case .awaitingArraySelection:
            return awaitingArraySelectionNote
        case .ready:
            break
        }
        if enhancement == .loadingWithBasic {
            return "Checking your solar forecast. Your estimate below already works without it."
        }
        // Name the actual blocker. A spent allowance or a stale balance is not a
        // Solcast failure, and telling the user to retry would be wrong.
        if let enhancementReason {
            return enhancementNote(enhancementReason)
        }
        if result.unavailableReason == .noEnergyNeeded { return nil }
        if let reason = result.unavailableReason, let detail = resultDetail(reason) {
            return "\(unavailableNotePrefix) \(detail)"
        }
        return causeNote(cause, forecastIsFutureDated: forecastIsFutureDated)
    }

    /// `nil` for reasons the device's own request bookkeeping explains better.
    private static func resultDetail(_ reason: LoadTimingForecastEstimator.UnavailableReason) -> String? {
        switch reason {
        case .noEnergyNeeded:
            return nil
        case .staleBalance:
            return "Energy observations are too old for the solar comparison, so it's paused."
        case .incompleteBalance:
            return "Some billing period bank data is missing, so the solar comparison is paused."
        case .noFittingRun:
            return "This load is longer than the search horizon. Try a smaller charge or a faster charging level."
        case .incompleteContext:
            return "There is not enough household history yet to estimate expected usage."
        case .missingTariff:
            return "An active rate plan is needed before costs can be compared."
        case .incompleteCoverage, .invalidInput:
            // These also stand in for "the view had nothing to evaluate", so the
            // device's own request bookkeeping is the better explanation.
            return nil
        }
    }

    // MARK: - Smart Shift card

    static let awaitingArraySelectionNote = "Choose your solar arrays to add a forecast. Your estimate below already works without it."

    /// What the forecast layer can add to the Smart Shift card. The card always has
    /// the forecast-free comparison, so anything short of a usable forecast becomes
    /// a one-sentence note reusing this file's explanations, without the prefix.
    static func forecastAvailability(
        state: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        cause: SolarForecastUnavailableCause?,
        reason: SolarForecastEnhancementUnavailableReason?,
        forecastFetchedAt: Date?,
        now: Date
    ) -> ForecastAvailability {
        switch connection {
        case .checking: return .loading
        case .notConnected: return .none
        case .awaitingArraySelection: return .unusable(firstSentence(awaitingArraySelectionNote))
        case .ready: break
        }
        let age = forecastFetchedAt.map { now.timeIntervalSince($0) }
        let isFresh = age.map { $0 >= 0 && $0 <= maximumForecastAge } ?? false
        // A refresh keeps the previous batch in memory until it is replaced. While
        // that batch is still fresh it keeps pricing the card, so the verdict
        // doesn't flip to the forecast-free answer and back on every pull.
        if state == .loadingWithBasic { return isFresh ? .ready : .loading }
        if state == .enhanced, isFresh { return .ready }
        if let reason { return .unusable(firstSentence(enhancementDetail(reason))) }
        return .unusable(firstSentence(causeDetail(cause, forecastIsFutureDated: age.map { $0 < 0 } ?? false)))
    }

    /// One sentence for a forecast comparison that couldn't run, shown beside the
    /// forecast-free comparison the card falls back to.
    static func forecastUnavailableNote(_ reason: LoadTimingForecastEstimator.UnavailableReason) -> String {
        firstSentence(resultDetail(reason) ?? causeDetail(nil, forecastIsFutureDated: false))
    }

    static func firstSentence(_ text: String) -> String {
        guard let end = text.range(of: ". ") else { return text }
        return String(text[..<end.lowerBound]) + "."
    }

    private static func enhancementNote(_ reason: SolarForecastEnhancementUnavailableReason) -> String {
        "\(unavailableNotePrefix) \(enhancementDetail(reason))"
    }

    private static func enhancementDetail(_ reason: SolarForecastEnhancementUnavailableReason) -> String {
        switch reason {
        case .requestFailed:
            return "This device could not reach your server for household data. "
                + "Check the app is signed in and online, then pull down to retry."
        case .serverOutdated:
            return "This app build is newer than the server it is talking to, "
                + "so household data cannot be loaded yet. Nothing is wrong with your data."
        case .contextInvalid:
            // `asOf` is a server timestamp read against this device's clock, so a
            // mis-set device clock lands here. Blaming the server would send the
            // user to file a bug that does not exist, and there is no in-app way to
            // file one anyway — so point at the clock, which the user can fix.
            return "This device could not use your household profile, which is "
                + "timestamped by your server. Check this device's date and time, then pull down to retry."
        case .contextMalformed:
            // The payload is unusable no matter what the clock says, so this must
            // not send someone to adjust their date. Say what is actually true
            // without inventing a fix or inviting a bug report about the server.
            return "The household profile your server sent could not be read by this "
                + "app version, so start times cannot be compared right now. Pull down to retry."
        case .contextUnavailable:
            return "This device could not read your household profile, so no start "
                + "time can be compared. It fills in as more energy data arrives."
        case .insufficientHistory:
            // The profile is built from the last 14 days only, so a site with years
            // of history can still fail here. Say so plainly rather than implying the
            // site has no history at all.
            return "Your household profile needs at least 5 complete days in the "
                + "last 14 days. Your energy history is intact, but too many of those recent days have gaps "
                + "to compare start times. It will resolve itself once those days fill in."
        case .timestampMisaligned:
            return "Your energy readings exist, but their timestamps do not line up "
                + "with this site's local time, so a household profile cannot be built. This is a data "
                + "problem rather than a missing-history one."
        case .forecastNotUsable:
            return "The saved forecast could not be used. Pull down to refresh it."
        case .billUnavailable:
            return "Bill data could not be refreshed, so costs cannot be compared yet."
        case .siteMismatch:
            return "Bill and household data disagree about this site. Pull down to retry."
        }
    }

    private static func causeNote(
        _ cause: SolarForecastUnavailableCause?,
        forecastIsFutureDated: Bool
    ) -> String {
        if cause == nil && forecastIsFutureDated { return futureDatedForecastNote }
        return "\(unavailableNotePrefix) \(causeDetail(cause, forecastIsFutureDated: false))"
    }

    private static func causeDetail(
        _ cause: SolarForecastUnavailableCause?,
        forecastIsFutureDated: Bool
    ) -> String {
        switch cause {
        case .unauthorized:
            return "Solcast rejected the saved key. Retry from Solar forecast settings."
        case .rateLimited:
            return "Solcast is limiting requests. Retry later today."
        case .requestFailed:
            return "Solcast could not be reached. Retry when you have a connection."
        case .unknownResource:
            return "Solcast does not recognise one of your Solar System IDs, "
                + "so that request counted as an attempt. Choose your arrays again in Solar forecast settings."
        case .invalidForecast:
            return "An array returned no usable forecast. Retry the array selection or refresh."
        case .storageFailure, .cleanupFailure:
            return "Saved forecast data could not be used. Retry a refresh."
        case .budgetExhausted:
            return "This device has used its forecast allowance for today. Try again tomorrow."
        case .deferred:
            return "Requests are paused until the daily limit resets. Retry tomorrow."
        case nil:
            // A future-dated forecast reaches the fallback only because its age
            // cannot be checked, so it needs its own note rather than the
            // "too old or incomplete" wording, which is false here.
            return forecastIsFutureDated
                ? futureDatedForecastNote
                : "The forecast was too old or incomplete to use. Pull down to refresh it."
        }
    }
}
