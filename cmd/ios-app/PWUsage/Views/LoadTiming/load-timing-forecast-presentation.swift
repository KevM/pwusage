import Foundation

/// Turns forecast state into what the Smart Shift card can show.
///
/// The card always has the forecast-free comparison, so anything short of a
/// usable forecast becomes a one-sentence note reusing this file's explanations.
enum LoadTimingForecastPresentation {
    /// Deliberately does not reuse the stale fallback: the forecast is present,
    /// and its age is unverifiable rather than too old. The batch is stamped with
    /// this device's own clock at fetch time (`SolarForecastStore.swift:503`), so
    /// a future-dated stamp means the clock has since moved backwards, not that
    /// the server sent the wrong time. Point at the clock, which the user can fix,
    /// the same way `contextInvalid` does for `asOf`.
    static let futureDatedForecastNote = "This solar forecast is timestamped later than this device's clock, so its age cannot be checked and it is not being used for now. Check this device's date and time, then pull down to refresh."
    /// Matches `SolarForecastStore.recommendationFreshness`. Data older than this
    /// may be shown as stale, but must not produce a new recommendation.
    static let maximumForecastAge: TimeInterval = 6 * 60 * 60

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

    /// What the forecast layer can add to the Smart Shift card.
    static func forecastAvailability(
        state: SolarForecastEnhancementState,
        connection: SolarForecastConnectionState,
        cause: SolarForecastUnavailableCause?,
        reason: SolarForecastEnhancementUnavailableReason?,
        forecastFetchedAt: Date?,
        now: Date,
        usesAutomaticForecast: Bool = false,
        automaticStatus: MobileSolarLayoutResponse? = nil
    ) -> ForecastAvailability {
        switch connection {
        case .checking: return .loading
        case .notConnected:
            return usesAutomaticForecast
                ? .automaticUnavailable(automaticUnavailableNote(status: automaticStatus, reason: reason)) : .none
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

    private static func automaticUnavailableNote(
        status: MobileSolarLayoutResponse?, reason: SolarForecastEnhancementUnavailableReason?
    ) -> String {
        if let reason { return firstSentence(enhancementDetail(reason)) }
        if case .enabled(_, let layout, let setupReason) = status, layout == nil, let setupReason {
            return SolarForecastSettingsStatus.sentence(for: setupReason)
        }
        return "The automatic solar forecast is unavailable. Your estimate uses recent grid history where available."
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
