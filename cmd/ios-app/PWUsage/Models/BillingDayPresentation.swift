import Foundation

/// The words and choices around a site's billing day. Wording follows `docs/voice-and-terms.md`.
enum BillingDayPresentation {
    static let days = Array(MobileBillingDay.validDays)

    static let settingTitle = "Bill start day"
    static let footer = "Your bill starts on this day each month. "
        + "In months with fewer days, it starts on the last day of the month."

    static let promptTitle = "Which day does your bill start?"
    static let promptMessage = "Your estimated bill and savings follow your billing cycle. "
        + "You can find the start day under billing period on your utility bill."

    static let saveFailure = "The day was not saved. Check your connection and try again."

    static func rowValue(day: Int) -> String {
        "Day \(day)"
    }
}
