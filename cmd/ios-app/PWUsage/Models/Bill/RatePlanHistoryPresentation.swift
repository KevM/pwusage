import Foundation
import PWUsageCore

/// Copy and formatting for the rate plan history guide. Voice follows `docs/voice-and-terms.md`.
enum RatePlanHistoryPresentation {
    // MARK: Offer (Home accessory and Rate Plans card)

    static let accessoryTitle = "Find your past rate plans"
    static let accessorySymbol = "clock.arrow.circlepath"
    static let notNowLabel = "Not now"
    static let findButtonTitle = "Find My Rate Plans"
    static let notNowButtonTitle = "Not Now"

    static func accessorySubtitle(utilityName: String?, historyStart: String) -> String {
        let since = "since \(monthYear(historyStart))"
        guard let utilityName, !utilityName.isEmpty else { return "Since \(monthYear(historyStart))" }
        return "\(utilityName) · \(since)"
    }

    static func offerMessage(historyStart: String) -> String {
        "Your system has been running since \(monthYear(historyStart)). "
            + "Want help finding the rate plans you’ve been on?"
    }

    // MARK: Titles and questions

    static let flowTitle = "Your Rate Plans"
    static let reviewTitle = "Review"

    /// The navigation title: `Your Rate Plans` while asking, `Review` last.
    static func navigationTitle(_ flow: RatePlanHistoryFlow) -> String {
        flow.step == .review ? reviewTitle : flowTitle
    }

    static func question(_ flow: RatePlanHistoryFlow) -> String {
        let plan = flow.currentPlan.map { displayName($0.name) } ?? ""
        let start = monthYear(flow.history.historyStart)
        // The plan the walk is asking about starts here; the one before it ends the day before.
        let before = flow.spans.last.map { monthYear($0.from) } ?? ""
        switch flow.step {
        case .currentKind: return currentQuestion(flow, kind: true)
        case .currentPlan: return currentQuestion(flow, kind: false)
        case .sinceStart:
            guard flow.spans.count > 1 else { return "Have you been on \(plan) since \(start)?" }
            let newer = monthYear(flow.spans[flow.spans.count - 2].from)
            return "Before \(newer), had you been on \(plan) since \(start)?"
        case .switchMonth: return "When did you switch to \(plan)?"
        case .kind: return "What kind of rate plan were you on before \(before)?"
        case .plan: return "Which plan were you on before \(before)?"
        case .peakHours: return "When does your Peak start and stop?"
        case .review: return reviewHeading(historyStart: flow.history.historyStart)
        }
    }

    /// With a Tesla plan the guide fills up to its start, so it asks about the plan there.
    private static func currentQuestion(_ flow: RatePlanHistoryFlow, kind: Bool) -> String {
        let subject = kind ? "What kind of rate plan" : "Which plan"
        guard let end = flow.history.fillThrough else { return "\(subject) are you on now?" }
        return "\(subject) were you on in \(monthYear(end))?"
    }

    // MARK: Buttons and pills

    static let continueTitle = "Continue"
    static let notSureTitle = "Not sure?"
    static let yesTitle = "Yes"
    static let noTitle = "No"
    static let changeTitle = "Change"
    static let saveTitle = "Save Rate Plans"
    static let savingTitle = "Saving Rate Plans…"
    static let retryTitle = "Try Again"
    static let kindMatchesTeslaPill = "Matches your Tesla rate plan"
    static let hoursMatchTeslaPill = "Matches your Tesla plan"
    static let closestPill = "Closest to your Tesla plan"
    static let standardPill = "Standard plan"
    static let assumedPill = "Assumed"

    /// The pill on a plan row: closest to the Tesla plan wins over the utility's standard plan.
    static func planPill(_ plan: RatePlanHistoryPlanDTO) -> String? {
        if plan.closest { return closestPill }
        return plan.isDefault ? standardPill : nil
    }

    // MARK: Kinds

    static func kindTitle(_ kind: RatePlanKind) -> String {
        switch kind {
        case .fixed: "Fixed"
        case .timeOfUse: "Time of Use"
        }
    }

    /// The kinds a step offers, Fixed first; a kind with no plans that year is hidden.
    static func kinds(in plans: [RatePlanHistoryPlanDTO]) -> [RatePlanKind] {
        [RatePlanKind.fixed, .timeOfUse].filter { kind in plans.contains { $0.kind == kind } }
    }

    /// `One price all day, like $0.19/kWh`, from the cheapest Fixed plan.
    static func kindDetail(_ kind: RatePlanKind, in plans: [RatePlanHistoryPlanDTO]) -> String? {
        switch kind {
        case .fixed:
            guard let plan = plans.filter({ $0.kind == .fixed }).min(by: { $0.lowRate < $1.lowRate }) else {
                return nil
            }
            return "One price all day, like \(fixedPrice(plan.lowRate))"
        case .timeOfUse:
            let options = plans.filter { $0.kind == .timeOfUse }
            guard let plan = options.first(where: \.closest) ?? options.first else { return nil }
            return "Off-Peak and Peak prices, like \(price(plan.lowRate)) and \(price(plan.highRate))"
        }
    }

    // MARK: Plans and hours

    /// The plan name without `(Single-Phase)` or `Single-Phase`, spaces collapsed.
    static func displayName(_ name: String) -> String {
        let stripped = name
            .replacingOccurrences(of: "(Single-Phase)", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "Single-Phase", with: "", options: .caseInsensitive)
        return stripped.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// The plan row's title: the display name, plus its Peak hours when another row in `plans` has the
    /// same name (`Residential Time-of-Use Rg 2 · Peak 7 AM – 7 PM`). A row grouping several Peak-hours
    /// options shows the span from the first window's start to the last window's end.
    static func planRowTitle(_ plan: RatePlanHistoryPlanDTO, among plans: [RatePlanHistoryPlanDTO]) -> String {
        let name = displayName(plan.name)
        let sharesName = plans.contains { $0.id != plan.id && displayName($0.name) == name }
        guard sharesName, let first = plan.peakWindows.first, let last = plan.peakWindows.last else { return name }
        let span = RatePlanPeakWindowDTO(label: first.label, fromHour: first.fromHour, toHour: last.toHour)
        return "\(name) · Peak \(windowRow(span))"
    }

    /// `Off-Peak $0.10 · Peak $0.27`, or `$0.19/kWh` for a Fixed plan.
    static func priceRow(_ plan: RatePlanHistoryPlanDTO) -> String {
        switch plan.kind {
        case .fixed: fixedPrice(plan.lowRate)
        case .timeOfUse: "Off-Peak \(price(plan.lowRate)) · Peak \(price(plan.highRate))"
        }
    }

    static func price(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }

    static func fixedPrice(_ value: Double) -> String {
        "\(price(value))/kWh"
    }

    /// `8 AM – 8 PM`; midnight is 12 AM, noon 12 PM, and hour 24 is 12 AM.
    static func windowRow(_ window: RatePlanPeakWindowDTO) -> String {
        "\(hourLabel(window.fromHour)) – \(hourLabel(window.toHour))"
    }

    static func hourLabel(_ hour: Int) -> String {
        let normalized = ((hour % 24) + 24) % 24
        let twelve = normalized % 12 == 0 ? 12 : normalized % 12
        return "\(twelve) \(normalized < 12 ? "AM" : "PM")"
    }

    static let hoursCaption = "Weekdays. Weekends are Off-Peak."

    // MARK: Help sheet

    static let helpTitle = "Which Kind Is It?"
    static let helpIntro = "Look at the energy charges on your bill."
    static let helpTimeOfUseBullets = [
        "• Separate “On-peak” and “Off-peak” kWh lines",
        "• The words “Time of Use”, “TOU” or “Time-of-Day”"
    ]
    static let helpFixedBullets = [
        "• One kWh line at one price",
        "• “Residential service” or “Standard”"
    ]
    static let stillNotSureTitle = "Still Not Sure"
    static let doneTitle = "Done"

    static func planCodesTitle(utilityName: String) -> String {
        "\(utilityName) plan codes"
    }

    /// One row per plan in effect: `Residential Rg 1 · Fixed`.
    static func planCodeRow(_ plan: RatePlanHistoryPlanDTO) -> String {
        "\(displayName(plan.name)) · \(kindTitle(plan.kind))"
    }

    static func stillNotSureCaption(hasTeslaPlan: Bool) -> String {
        hasTeslaPlan ? "We’ll go with your Tesla rate plan." : "We’ll go with your utility’s standard plan."
    }

    // MARK: Switch month

    /// `March 2025` for a `YYYY-MM` month.
    static func switchMonthLabel(_ month: String) -> String {
        guard let (year, index) = yearAndMonth(month) else { return month }
        return "\(monthNames[index - 1]) \(year)"
    }

    // MARK: Review

    static let reviewFooter = "Priced from public utility rates. You can edit them in Rate Plans."
    static let teslaRowCaption = "Your Tesla rate plan"

    static func reviewHeading(historyStart: String) -> String {
        "Your rate plans since \(monthYear(historyStart))"
    }

    static func teslaRange(from start: String) -> String {
        RatePlanTimelineFormatting.displayRange(from: start, to: nil)
    }

    /// The greyed Tesla row in review: the plan Tesla reports, from the day after the last span the
    /// guide fills. Absent without a Tesla plan name or a `fillThrough` (nothing marks where Tesla starts).
    struct TeslaRow: Equatable {
        let name: String
        let range: String
    }

    static func teslaRow(history: RatePlanHistoryDTO, teslaPlanName: String?) -> TeslaRow? {
        guard let teslaPlanName, !teslaPlanName.isEmpty,
              let fillThrough = history.fillThrough,
              let last = RatePlanTimelineFormatting.parseYMD(fillThrough) else {
            return nil
        }
        // `parseYMD` is UTC midnight, so one day is exactly 86,400 seconds.
        let first = RatePlanTimelineFormatting.formatYMD(last.addingTimeInterval(86_400))
        return TeslaRow(name: teslaPlanName, range: teslaRange(from: first))
    }

    /// `Residential Rg 2 · Peak 8 AM – 8 PM` (the window when the span has one).
    static func spanTitle(_ span: RatePlanHistoryFlow.Span) -> String {
        let name = displayName(span.plan.name)
        guard let label = span.windowLabel,
              let window = span.plan.peakWindows.first(where: { $0.label == label }) else { return name }
        return "\(name) · Peak \(windowRow(window))"
    }

    static func spanRange(_ span: RatePlanHistoryFlow.Span) -> String {
        RatePlanTimelineFormatting.displayRange(from: span.from, to: span.endDate)
    }

    // MARK: Errors

    static let loadFailureMessage = "Couldn’t load your utility’s rate plans. Check your connection and try again."
    static let saveFailureMessage = "Couldn’t save your rate plans. Check your connection and try again."

    /// A server 400/409 message is shown as-is; anything else gets the generic save failure.
    static func saveErrorMessage(for error: any Error) -> String {
        serverMessage(in: error) ?? saveFailureMessage
    }

    /// A server 400/409 message (`Choose a utility first.`) is shown as-is; anything else gets the
    /// generic load failure.
    static func loadErrorMessage(for error: any Error) -> String {
        serverMessage(in: error) ?? loadFailureMessage
    }

    private static func serverMessage(in error: any Error) -> String? {
        guard case .requestRejected(let status, let message?) = error as? PWUsageAPIError,
              status == 400 || status == 409, !message.isEmpty else { return nil }
        return message
    }

    // MARK: Dates

    private static let monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]

    /// `Nov 2023` from a `YYYY-MM-DD` day.
    static func monthYear(_ day: String) -> String {
        guard let (year, index) = yearAndMonth(day) else { return day }
        return "\(monthNames[index - 1].prefix(3)) \(year)"
    }

    private static func yearAndMonth(_ text: String) -> (Int, Int)? {
        let parts = text.split(separator: "-")
        guard parts.count >= 2, let year = Int(parts[0]), let month = Int(parts[1]), (1 ... 12).contains(month) else {
            return nil
        }
        return (year, month)
    }
}
