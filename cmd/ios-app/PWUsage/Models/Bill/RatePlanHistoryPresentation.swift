import Foundation

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

    /// The navigation title: the year on year steps, `Your Rate Plans` on the current plan's, `Review` last.
    static func navigationTitle(_ flow: RatePlanHistoryFlow) -> String {
        switch flow.step {
        case .currentKind, .currentPlan: flowTitle
        case .peakHours(let year): flow.spans.isEmpty ? flowTitle : String(year)
        case .stillOn(let year), .kind(let year, _), .plan(let year, _), .switchMonth(let year): String(year)
        case .review: reviewTitle
        }
    }

    static func question(_ flow: RatePlanHistoryFlow) -> String {
        let plan = flow.currentPlan.map { displayName($0.name) } ?? ""
        switch flow.step {
        case .currentKind: return "What kind of rate plan are you on now?"
        case .currentPlan: return "Which plan are you on now?"
        case .stillOn(let year): return "In \(year), were you still on \(plan)?"
        case .kind(let year, _): return "In \(year), what kind of rate plan were you on?"
        case .plan(let year, _): return "Which plan were you on in \(year)?"
        case .peakHours: return "When does your Peak start and stop?"
        case .switchMonth: return "About when did you switch to \(plan)?"
        case .review: return reviewHeading(historyStart: flow.history.historyStart)
        }
    }

    /// The line above the kind question when the current plan isn't listed that year.
    static func notListedLine(_ flow: RatePlanHistoryFlow) -> String? {
        guard case .kind(let year, true) = flow.step, let plan = flow.currentPlan else { return nil }
        return "\(displayName(plan.name)) isn’t listed for \(year)."
    }

    /// `2025 · 2024 · 2023` on the still-on step: the years asked so far, newest first.
    static func progressLine(_ flow: RatePlanHistoryFlow) -> String? {
        guard case .stillOn(let year) = flow.step else { return nil }
        return flow.history.years.map(\.year).filter { $0 >= year }.map(String.init).joined(separator: " · ")
    }

    // MARK: Buttons and pills

    static let continueTitle = "Continue"
    static let notSureTitle = "Not sure?"
    static let yesTitle = "Yes"
    static let noTitle = "No"
    static let changeTitle = "Change"
    static let saveTitle = "Save Rate Plans"
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
        if case .requestRejected(let status, let message?) = error as? PWUsageAPIError,
           status == 400 || status == 409, !message.isEmpty {
            return message
        }
        return saveFailureMessage
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
