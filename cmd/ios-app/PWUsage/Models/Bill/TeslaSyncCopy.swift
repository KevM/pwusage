import Foundation
import PWUsageCore

/// Fixed copy for Sync to Tesla, from the global constraints and docs/voice-and-terms.md.
enum TeslaSyncCopy {
    static let sendButton = "Sync to Tesla"
    static let cancelButton = "Cancel"
    static let doneButton = "Done"
    static let reconnectButton = "Reconnect Tesla"
    static let postApplyPrompt = "Also update your Powerwall?"
    static let notNowButton = "Not now"
    static let effect = "Your Powerwall will start scheduling against these prices. "
        + "You can change this in the Tesla app at any time."
    static let publicPlans = "These rates are estimated from public utility rates. Tesla will use them as shown."
    static let confirmed = "Tesla now has this plan."
    static let unconfirmed = "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again."
    static let inFlight = "Already sending this plan to Tesla."
    static let notAllowed = "Tesla didn't allow this account to change the Powerwall's rate plan. Nothing changed."
    static let reconnectNeeded = "Reconnect Tesla to sync this plan."
    static let couldNotReach = "Couldn't reach Tesla. Nothing changed on your Powerwall."
    static let conflict = "Tesla or your rate plan changed since you reviewed it. Review the plan again before syncing."

    /// The one line to show for a commit's outcome. `conflict` never shows (the model reloads the review).
    /// What the sending screen says while the request is open. The server writes first, then reads Tesla
    /// back for up to 20 seconds, so after the first few seconds the wait is Tesla confirming.
    static func sendingStatus(afterSeconds elapsed: Double) -> String {
        elapsed < 4
            ? "Sending your plan to Tesla…"
            : "Waiting for Tesla to confirm. This can take up to 20 seconds."
    }

    static func resultMessage(_ outcome: String, message: String?) -> String {
        switch outcome {
        case "confirmed": confirmed
        case "unconfirmed": unconfirmed
        case "rejected": rejectedMessage(message)
        case "not_allowed": notAllowed
        case "needs_reauth": message ?? reconnectNeeded
        case "in_flight": inFlight
        case "conflict": message ?? conflict
        default: message ?? couldNotReach
        }
    }

    /// Tesla's words are shown as given, without a doubled full stop.
    private static func rejectedMessage(_ message: String?) -> String {
        let reason = (message ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !reason.isEmpty else {
            return "Tesla didn't accept this plan. Nothing changed on your Powerwall."
        }
        return "Tesla didn't accept this plan: \(reason). Nothing changed on your Powerwall."
    }

    /// One rate Tesla will store differently, e.g. "Tesla will store Peak buy as $0.25 (raised ...)."
    static func adjustmentLine(_ adjustment: TeslaSyncAdjustmentDTO, currency: String) -> String {
        let period = adjustment.period.displayName
        let price = RateFormatting.formatRate(adjustment.stored, currency: currency)
        switch adjustment.reason {
        case "raised_to_sell":
            return "Tesla will store \(period) buy as \(price) (raised to match the \(price) export rate)."
        default:
            let side = adjustment.side == "sell" ? "export" : "buy"
            return "Tesla will store \(period) \(side) as \(price) (negative prices become zero)."
        }
    }
}

/// When to offer Sync to Tesla right after the owner applies a rate plan change in PWUsage.
enum TeslaSyncPrompt {
    static func offers(afterApplying request: TariffSelectionRequest, timeline: SiteTariffsTimelineResponse) -> Bool {
        guard request.scope == .actual, timeline.teslaSync.syncAvailable else { return false }
        let timeZone = TimeZone(identifier: timeline.timezone) ?? .current
        let today = RatePlanTimelineFormatting.formatYMD(Date(), in: timeZone)
        guard request.effectiveFrom <= today else { return false }
        guard let end = request.effectiveTo else { return true }
        return today <= end
    }

    /// A sync Tesla hadn't confirmed when sent: pull once on open so the answer shows without a manual check.
    static func shouldPullOnOpen(_ timeline: SiteTariffsTimelineResponse) -> Bool {
        timeline.teslaSync.lastSync?.status == "unconfirmed"
    }
}
