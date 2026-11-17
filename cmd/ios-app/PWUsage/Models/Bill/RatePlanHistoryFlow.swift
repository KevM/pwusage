import Foundation

/// The rate plan history guide's walk-back: the current plan first, then one question per
/// listed year, newest first. Pure state; the view renders `step` and calls the answers.
struct RatePlanHistoryFlow: Equatable, Sendable {
    enum Step: Equatable, Sendable {
        /// "What kind of rate plan are you on now?"
        case currentKind
        case currentPlan(RatePlanKind)
        /// "In <year>, were you still on <plan>?"
        case stillOn(year: Int)
        /// `notListed`: the current plan isn't listed that year.
        case kind(year: Int, notListed: Bool)
        case plan(year: Int, RatePlanKind)
        /// "When does your Peak start and stop?" (only for plans with 2+ windows)
        case peakHours(year: Int)
        /// "About when did you switch to <plan>?"
        case switchMonth(year: Int)
        case review
    }

    /// One plan over a run of days, `YYYY-MM-DD` site-local.
    struct Span: Equatable, Sendable {
        let plan: RatePlanHistoryPlanDTO
        var windowLabel: String?
        var from: String
        var endDate: String?
        var assumed: Bool

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
        let yearIndex: Int
    }

    let history: RatePlanHistoryDTO
    let hasTeslaPlan: Bool
    private(set) var step: Step = .currentKind
    /// Newest first; the last one is the plan the walk is asking about.
    private(set) var spans: [Span] = []
    private var pick = Pick()
    private var yearIndex = 0
    private var undo: [Snapshot] = []

    init(history: RatePlanHistoryDTO, hasTeslaPlan: Bool) {
        self.history = history
        self.hasTeslaPlan = hasTeslaPlan
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

    /// The plan the still-on and switch-month questions name.
    var currentPlan: RatePlanHistoryPlanDTO? {
        spans.last?.plan
    }

    func plans(for step: Step) -> [RatePlanHistoryPlanDTO] {
        switch step {
        case .currentKind: history.current
        case let .currentPlan(kind): history.current.filter { $0.kind == kind }
        case let .stillOn(year), let .kind(year, _): plans(in: year)
        case let .plan(year, kind): plans(in: year).filter { $0.kind == kind }
        case .peakHours, .switchMonth, .review: []
        }
    }

    /// `YYYY-MM`, newest first: from the current plan's start month down to February of `year`,
    /// keeping only months after the history start so the older plan gets at least one day.
    func switchMonths(year: Int) -> [String] {
        guard let newer = spans.last, let upper = YearMonth(day: newer.from) else { return [] }
        let lower = YearMonth(year: year, month: 2)
        var months: [String] = []
        var month = upper
        while month >= lower {
            if month.firstDay > history.historyStart {
                months.append(month.text)
            }
            month = month.previous
        }
        return months
    }

    /// January of `year + 1` when offered, else the newest month offered.
    func defaultSwitchMonth(year: Int) -> String? {
        let months = switchMonths(year: year)
        let january = YearMonth(year: year + 1, month: 1).text
        return months.contains(january) ? january : months.first
    }

    /// Oldest first, contiguous; the newest `to` is `fillThrough` (nil = open).
    /// Adjacent spans with one label (split only by `assumed`, which the review shows) are one period,
    /// so the server saves each public rate change once.
    func periods() -> [RatePlanHistoryPeriod] {
        var result: [RatePlanHistoryPeriod] = []
        let filled = spans.reversed().filter { span in span.endDate.map { span.from <= $0 } ?? true }
        for span in filled {
            if let older = result.last, older.label == span.label {
                result[result.count - 1] = RatePlanHistoryPeriod(label: span.label, from: older.from, to: span.endDate)
            } else {
                result.append(RatePlanHistoryPeriod(label: span.label, from: span.from, to: span.endDate))
            }
        }
        return result
    }

    // MARK: - Answers

    mutating func chooseKind(_ kind: RatePlanKind) {
        let year: Int?
        switch step {
        case .currentKind: year = nil
        case let .kind(asked, _): year = asked
        default: return
        }
        save()
        pick = Pick()
        let options = candidates.filter { $0.kind == kind }
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

    mutating func answerStillOn(_ yes: Bool) {
        guard case let .stillOn(year) = step else { return }
        save()
        if yes {
            extendCurrentPlan(assumed: false)
            goToYear(yearIndex + 1)
        } else {
            step = .kind(year: year, notListed: false)
        }
    }

    mutating func chooseSwitchMonth(_ month: String) {
        guard case let .switchMonth(year) = step, switchMonths(year: year).contains(month) else { return }
        save()
        applySwitch(month: month, year: year)
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
        case .stillOn:
            save()
            extendCurrentPlan(assumed: true)
            goToYear(yearIndex + 1)
        case let .switchMonth(year):
            guard let month = defaultSwitchMonth(year: year) else { return }
            save()
            pick.assumed = true
            applySwitch(month: month, year: year)
        case .review:
            return
        }
    }

    mutating func back() {
        guard let previous = undo.popLast() else { return }
        step = previous.step
        spans = previous.spans
        pick = previous.pick
        yearIndex = previous.yearIndex
    }

    // MARK: - Transitions

    /// The plans the current kind/plan step chooses from.
    private var candidates: [RatePlanHistoryPlanDTO] {
        spans.isEmpty ? history.current : askedYear.map(plans(in:)) ?? []
    }

    private var askedYear: Int? {
        history.years.indices.contains(yearIndex) ? history.years[yearIndex].year : nil
    }

    /// The year the current plan's hours step names.
    private var currentYear: Int {
        if let newest = history.years.first { return newest.year + 1 }
        return YearMonth(day: history.fillThrough ?? history.historyStart)?.year ?? 0
    }

    /// Where the current plan starts before the walk: January after the newest asked year.
    private var newestFrom: String {
        let start = history.years.first.map { YearMonth(year: $0.year + 1, month: 1).firstDay }
        return max(start ?? history.historyStart, history.historyStart)
    }

    private func plans(in year: Int) -> [RatePlanHistoryPlanDTO] {
        history.years.first { $0.year == year }?.plans ?? []
    }

    private func notSurePlan(from options: [RatePlanHistoryPlanDTO]) -> RatePlanHistoryPlanDTO? {
        if hasTeslaPlan {
            return options.first(where: \.closest)
                ?? options.first { $0.kind == history.teslaShape }
                ?? options.first
        }
        return options.first(where: \.isDefault) ?? options.first { $0.kind == .fixed } ?? options.first
    }

    private func yearStart(_ year: Int) -> String {
        max(YearMonth(year: year, month: 1).firstDay, history.historyStart)
    }

    private mutating func save() {
        undo.append(Snapshot(step: step, spans: spans, pick: pick, yearIndex: yearIndex))
    }

    private mutating func take(_ plan: RatePlanHistoryPlanDTO) {
        pick.plan = plan
        if plan.peakWindows.count > 1 {
            step = .peakHours(year: spans.isEmpty ? currentYear : askedYear ?? currentYear)
        } else {
            pick.windowLabel = plan.peakWindows.first?.label
            finishPick()
        }
    }

    /// Turns a finished pick into the current plan, an extension of it, or a switch question.
    private mutating func finishPick() {
        guard let plan = pick.plan else { return }
        guard let current = spans.last else {
            spans = [Span(
                plan: plan, windowLabel: pick.windowLabel, from: newestFrom,
                endDate: history.fillThrough, assumed: pick.assumed
            )]
            pick = Pick()
            goToYear(0)
            return
        }
        if plan.name == current.plan.name, pick.windowLabel == current.windowLabel {
            extendCurrentPlan(assumed: pick.assumed)
            pick = Pick()
            goToYear(yearIndex + 1)
        } else if let year = askedYear {
            step = .switchMonth(year: year)
        }
    }

    /// Covers all of the asked year with the current plan; an assumed year is its own span.
    private mutating func extendCurrentPlan(assumed: Bool) {
        guard let year = askedYear, let current = spans.last else { return }
        let start = yearStart(year)
        if current.assumed == assumed {
            spans[spans.count - 1].from = start
        } else {
            spans.append(Span(
                plan: current.plan, windowLabel: current.windowLabel, from: start,
                endDate: IsoDay.dayBefore(current.from), assumed: assumed
            ))
        }
    }

    private mutating func applySwitch(month: String, year: Int) {
        guard let plan = pick.plan, !spans.isEmpty else { return }
        let switchDay = "\(month)-01"
        spans[spans.count - 1].from = switchDay
        spans.append(Span(
            plan: plan, windowLabel: pick.windowLabel, from: yearStart(year),
            endDate: IsoDay.dayBefore(switchDay), assumed: pick.assumed
        ))
        pick = Pick()
        goToYear(yearIndex + 1)
    }

    private mutating func goToYear(_ index: Int) {
        yearIndex = index
        guard history.years.indices.contains(index) else {
            step = .review
            return
        }
        let year = history.years[index]
        let isListed = year.plans.contains { $0.name == spans.last?.plan.name }
        step = isListed ? .stillOn(year: year.year) : .kind(year: year.year, notListed: true)
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

private enum IsoDay {
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
