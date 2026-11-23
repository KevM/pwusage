import Foundation
import PWUsageCore

/// The rate plan history guide's walk-back: the current plan first, then one question per plan,
/// "since the start?", and on No, when they switched and what they were on before.
/// Pure state; the view renders `step` and calls the answers.
struct RatePlanHistoryFlow: Equatable, Sendable {
    enum Step: Equatable, Sendable {
        /// "What kind of rate plan are you on now?"
        case currentKind
        case currentPlan(RatePlanKind)
        /// "Have you been on <plan> since <history start>?"
        case sinceStart
        /// "When did you switch to <plan>?"
        case switchMonth
        /// The plan before the switch; `year` is the year it ended in, whose plans are listed.
        case kind(year: Int)
        case plan(year: Int, RatePlanKind)
        /// "When does your Peak start and stop?" (only for plans with 2+ windows)
        case peakHours(year: Int)
        case review
    }

    /// One plan over a run of days, `YYYY-MM-DD` site-local.
    struct Span: Equatable, Sendable {
        let plan: RatePlanHistoryPlanDTO
        var windowLabel: String?
        var from: String
        var endDate: String?
        var assumed: Bool
        /// The owner's changed fixed comparison for this plan's whole range; nil keeps the prefill.
        var fixed: FixedComparisonChoice?

        /// The URDB label sent on save.
        var label: String {
            windowLabel ?? plan.fixedLabel ?? plan.name
        }
    }

    /// The plan being picked across the kind → plan → hours screens, before it becomes a span.
    private struct Pick: Equatable, Sendable {
        var plan: RatePlanHistoryPlanDTO?
        var windowLabel: String?
        var assumed = false
    }

    private struct Snapshot: Equatable, Sendable {
        let step: Step
        let spans: [Span]
        let pick: Pick
    }

    let history: RatePlanHistoryDTO
    let hasTeslaPlan: Bool
    /// Site-local `YYYY-MM-DD`: the newest switch month offered when the plan is open (no Tesla).
    let today: String
    /// The site's stored fixed comparison (reference) periods the guide prefills rows from.
    let referencePeriods: [TariffPeriodDTO]
    private(set) var step: Step = .currentKind
    /// Newest first; the last one is the plan the walk is asking about.
    private(set) var spans: [Span] = []
    private var pick = Pick()
    private var undo: [Snapshot] = []

    init(
        history: RatePlanHistoryDTO,
        hasTeslaPlan: Bool,
        today: String = IsoDay.today(),
        referencePeriods: [TariffPeriodDTO] = []
    ) {
        self.history = history
        self.hasTeslaPlan = hasTeslaPlan
        self.today = today
        self.referencePeriods = referencePeriods
    }

    /// Tesla's shape, on the first step only.
    var preselectedKind: RatePlanKind? {
        step == .currentKind ? history.teslaShape : nil
    }

    /// The plan whose Peak hours the hours step asks about.
    var pickedPlan: RatePlanHistoryPlanDTO? {
        pick.plan
    }

    /// The window closest to the Tesla plan, on the hours step.
    var preselectedWindowLabel: String? {
        guard case .peakHours = step else { return nil }
        return pick.plan?.closestWindow
    }

    /// The plan the since-start and switch-month questions name.
    var currentPlan: RatePlanHistoryPlanDTO? {
        spans.last?.plan
    }

    func plans(for step: Step) -> [RatePlanHistoryPlanDTO] {
        switch step {
        case .currentKind: history.current
        case let .currentPlan(kind): history.current.filter { $0.kind == kind }
        case let .kind(year): plans(endingIn: year)
        case let .plan(year, kind): plans(endingIn: year).filter { $0.kind == kind }
        case .sinceStart, .switchMonth, .peakHours, .review: []
        }
    }

    /// `YYYY-MM`, newest first: the months the asked plan could have started in, from its last
    /// month down to the month after the history start, so the plan before it gets at least one day.
    func switchMonths() -> [String] {
        guard let asked = spans.last, let upper = YearMonth(day: asked.endDate ?? today) else { return [] }
        var months: [String] = []
        var month = upper
        while month.firstDay > history.historyStart {
            months.append(month.text)
            month = month.previous
        }
        return months
    }

    /// The newest January offered (rates often change then), else the newest month offered.
    func defaultSwitchMonth() -> String? {
        let months = switchMonths()
        return months.first { $0.hasSuffix("-01") } ?? months.first
    }

    /// Oldest first, contiguous; the newest `to` is `fillThrough` (nil = open).
    /// Adjacent spans with one label (split only by `assumed`, which the review shows) are one period,
    /// so the server saves each public rate change once.
    func periods() -> [RatePlanHistoryPeriod] {
        var result: [RatePlanHistoryPeriod] = []
        let filled = spans.indices.reversed().filter { index in
            spans[index].endDate.map { spans[index].from <= $0 } ?? true
        }
        for index in filled {
            let span = spans[index]
            let fixed = stagedFixed(forSpanAt: index)
            if let older = result.last, older.label == span.label {
                // Merged spans keep the older span's staged comparison, else the newer one's.
                result[result.count - 1] = RatePlanHistoryPeriod(
                    label: span.label, from: older.from, to: span.endDate, fixed: older.fixed ?? fixed
                )
            } else {
                result.append(RatePlanHistoryPeriod(label: span.label, from: span.from, to: span.endDate, fixed: fixed))
            }
        }
        return result
    }

    // MARK: - Answers

    mutating func chooseKind(_ kind: RatePlanKind) {
        let year: Int?
        switch step {
        case .currentKind: year = nil
        case let .kind(asked): year = asked
        default: return
        }
        let options = plans(for: step).filter { $0.kind == kind }
        save()
        pick = Pick()
        if options.count == 1, let only = options.first {
            take(only)
        } else {
            step = year.map { .plan(year: $0, kind) } ?? .currentPlan(kind)
        }
    }

    mutating func choosePlan(_ plan: RatePlanHistoryPlanDTO) {
        switch step {
        case .currentPlan, .plan: break
        default: return
        }
        save()
        pick = Pick()
        take(plan)
    }

    mutating func choosePeakWindow(_ window: RatePlanPeakWindowDTO) {
        guard case .peakHours = step, pick.plan != nil else { return }
        save()
        pick.windowLabel = window.label
        finishPick()
    }

    mutating func answerSinceStart(_ yes: Bool) {
        guard step == .sinceStart else { return }
        save()
        step = yes || switchMonths().isEmpty ? .review : .switchMonth
    }

    mutating func chooseSwitchMonth(_ month: String) {
        guard step == .switchMonth, switchMonths().contains(month) else { return }
        save()
        applySwitch(month: month)
    }

    /// The help sheet's Still Not Sure: answers this step with the best guess, marked assumed.
    mutating func stillNotSure() {
        switch step {
        case .currentKind, .currentPlan, .kind, .plan:
            // The plan steps list only the kind the owner chose, so the guess keeps to it.
            guard let plan = notSurePlan(from: plans(for: step)) else { return }
            save()
            pick = Pick(plan: plan, windowLabel: plan.closestWindow ?? plan.peakWindows.first?.label, assumed: true)
            finishPick()
        case .peakHours:
            guard let plan = pick.plan else { return }
            save()
            pick.assumed = true
            pick.windowLabel = plan.closestWindow ?? plan.peakWindows.first?.label
            finishPick()
        case .sinceStart:
            save()
            spans[spans.count - 1].assumed = true
            step = .review
        case .switchMonth:
            guard let month = defaultSwitchMonth() else { return }
            save()
            spans[spans.count - 1].assumed = true
            applySwitch(month: month)
        case .review:
            return
        }
    }

    /// Stages `choice` as the fixed comparison for the whole plan at `index`, replacing every row
    /// shown for it. An index past the spans changes nothing.
    mutating func chooseFixed(_ choice: FixedComparisonChoice, forSpanAt index: Int) {
        guard spans.indices.contains(index) else { return }
        save()
        spans[index].fixed = choice
    }

    mutating func back() {
        guard let previous = undo.popLast() else { return }
        step = previous.step
        spans = previous.spans
        pick = previous.pick
    }

    // MARK: - Transitions

    /// The year a newly picked plan ends in: the year before the asked plan's start, or the
    /// current plan's year.
    private var pickYear: Int {
        if let asked = spans.last { return YearMonth(day: IsoDay.dayBefore(asked.from))?.year ?? 0 }
        if let newest = history.years.first { return newest.year + 1 }
        return YearMonth(day: history.fillThrough ?? today)?.year ?? 0
    }

    /// The plans listed for a year; today's when the server listed none for it.
    private func plans(endingIn year: Int) -> [RatePlanHistoryPlanDTO] {
        let listed = history.years.first { $0.year == year }?.plans ?? []
        return listed.isEmpty ? history.current : listed
    }

    private func notSurePlan(from options: [RatePlanHistoryPlanDTO]) -> RatePlanHistoryPlanDTO? {
        if hasTeslaPlan {
            return options.first(where: \.closest)
                ?? options.first { $0.kind == history.teslaShape }
                ?? options.first
        }
        return options.first(where: \.isDefault) ?? options.first { $0.kind == .fixed } ?? options.first
    }

    private mutating func save() {
        undo.append(Snapshot(step: step, spans: spans, pick: pick))
    }

    private mutating func take(_ plan: RatePlanHistoryPlanDTO) {
        pick.plan = plan
        if plan.peakWindows.count > 1 {
            step = .peakHours(year: pickYear)
        } else {
            pick.windowLabel = plan.peakWindows.first?.label
            finishPick()
        }
    }

    /// Turns a finished pick into a span reaching back to the history start, then asks whether it did.
    private mutating func finishPick() {
        guard let plan = pick.plan else { return }
        let endDate = spans.last.map { IsoDay.dayBefore($0.from) } ?? history.fillThrough
        spans.append(Span(
            plan: plan, windowLabel: pick.windowLabel, from: history.historyStart,
            endDate: endDate, assumed: pick.assumed
        ))
        pick = Pick()
        step = .sinceStart
    }

    /// Starts the asked plan in `month`, then asks for the plan before it.
    private mutating func applySwitch(month: String) {
        guard !spans.isEmpty else { return }
        spans[spans.count - 1].from = "\(month)-01"
        pick = Pick()
        step = .kind(year: pickYear)
    }
}

// MARK: - Calendar math on site-local day strings

private struct YearMonth: Comparable {
    let year: Int
    let month: Int

    init(year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    /// From `YYYY-MM-DD` (or `YYYY-MM`).
    init?(day: String) {
        let parts = day.split(separator: "-")
        guard parts.count >= 2, let year = Int(parts[0]), let month = Int(parts[1]) else { return nil }
        self.init(year: year, month: month)
    }

    var text: String {
        String(format: "%04d-%02d", year, month)
    }

    var firstDay: String {
        "\(text)-01"
    }

    var previous: YearMonth {
        month == 1 ? YearMonth(year: year - 1, month: 12) : YearMonth(year: year, month: month - 1)
    }

    static func < (lhs: YearMonth, rhs: YearMonth) -> Bool {
        (lhs.year, lhs.month) < (rhs.year, rhs.month)
    }
}

enum IsoDay {
    /// Today in the device's zone, `YYYY-MM-DD`.
    static func today(_ now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 1, parts.day ?? 1)
    }

    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    /// The day before a `YYYY-MM-DD` day; the input unchanged when it doesn't parse.
    static func dayBefore(_ day: String) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
              let before = calendar.date(byAdding: .day, value: -1, to: date) else { return day }
        let out = calendar.dateComponents([.year, .month, .day], from: before)
        return String(format: "%04d-%02d-%02d", out.year ?? 0, out.month ?? 1, out.day ?? 1)
    }
}
