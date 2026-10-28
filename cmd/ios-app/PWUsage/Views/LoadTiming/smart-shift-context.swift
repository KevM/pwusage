import Foundation

extension SmartShiftPresentation {
    // MARK: - Verdict

    struct Context {
        let profile: LoadProfile
        let comparison: LoadTimingForecastEstimator.Comparison
        let timing: LoadTiming
        let now: Date
        /// `nil` where no bill date is shown.
        let billingCycleEnd: Date?
        let currencyCode: String
        let timeZone: String

        var isNow: Bool { comparison.recommendedStart <= comparison.horizonStart }

        func shortDate(_ date: Date) -> String { SmartShiftPresentation.shortDate(date, timeZone: timeZone) }

        var verb: String {
            guard profile.kind != .custom, let first = profile.name.split(separator: " ").first else { return "Start" }
            return String(first)
        }

        var laterLabel: String { "\(verb) later" }
        var nowLabel: String { "\(verb) now" }

        func money(_ amount: Double) -> String { DashboardPresentation.currency(amount, code: currencyCode) }

        /// "at 4:30 PM", or "tomorrow at 4:30 PM" when the start falls on a later local day,
        /// with the day first so it can't be missed.
        func when(_ date: Date) -> String {
            let clock = DashboardPresentation.date(date, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone) ?? .current
            return calendar.isDate(date, inSameDayAs: now) ? "at \(clock)" : "tomorrow at \(clock)"
        }

        func capitalized(_ phrase: String) -> String {
            phrase.prefix(1).uppercased() + phrase.dropFirst()
        }

        func name(_ key: String) -> String {
            periodTitle(key, timing: timing)
        }

        func periodKey(at date: Date) -> String? {
            timing.tariffTimeline.first { $0.start <= date && date < $0.end }?.periodKey
        }

        func startKwh(_ key: String) -> Double? {
            comparison.lanes.first { $0.periodKey == key }?.startKwh
        }

        func bankPhrase(_ key: String) -> String {
            let kwh = startKwh(key) ?? 0
            return roundedKwh(kwh) > 0 ? "have \(roundedKwh(kwh)) kWh banked" : "have no bank"
        }

        var headline: String {
            let time = isNow ? "now" : when(comparison.recommendedStart)
            // A safe start that is also cheaper than now keeps the saving headline.
            if claimsSaving {
                return "\(profile.name) \(time): about \(money(comparison.savings)) cheaper than now"
            }
            switch comparison.safety {
            case .nowSafe:
                return "\(profile.name) now: no cheaper time today"
            case .nowUnsafe(let key):
                let more = max(0, comparison.recommendedCost - comparison.costNow)
                return "\(profile.name) \(time): about \(money(more)) more than now, but it won't leave \(name(key)) short"
            case .noSafeStart(let key):
                return "\(profile.name) \(time): the least risky time, but a cloudy week could still leave \(name(key)) short"
            }
        }

        /// Shorter is better only when the recommendation is also the cheaper bar:
        /// never when no start is safe, and not when the safe start costs more than now.
        var claimsSaving: Bool {
            guard !isNow else { return false }
            switch comparison.safety {
            case .nowSafe: return true
            case .nowUnsafe:
                return comparison.costNow - comparison.recommendedCost > LoadTimingForecastEstimator.currencyMinorUnit(currencyCode)
            case .noSafeStart: return false
            }
        }

        func verdict(forecast: ForecastAvailability) -> SmartShiftVerdict {
            let nowBar = CostBar(label: nowLabel, amount: money(comparison.costNow), value: comparison.costNow, isRecommended: isNow)
            let bars = isNow
                ? [nowBar]
                : [CostBar(label: laterLabel, amount: money(comparison.recommendedCost), value: comparison.recommendedCost,
                           isRecommended: true), nowBar]
            let lanes = comparison.lanes.map(lane)
            return SmartShiftVerdict(
                headline: headline,
                barsCaption: claimsSaving ? "Added to your bill (shorter is better)" : "Added to your bill",
                bars: bars,
                percentLess: percentLess,
                why: why,
                laterLabel: laterLabel,
                nowLabel: nowLabel,
                lanes: lanes,
                axisDates: axisDates,
                notes: notes(forecast: forecast),
                accessibilitySummary: accessibilitySummary
            )
        }

        var switchMarkers: [SwitchMarker] {
            comparison.periodSwitches.map { date in
                let before = timing.tariffTimeline.first { $0.end == date }.map { name($0.periodKey) }
                let after = timing.tariffTimeline.first { $0.start == date }.map { name($0.periodKey) }
                let beforeLabel = before.map { "\u{2190} \($0)" }, afterLabel = after.map { "\($0) \u{2192}" }
                let label = [beforeLabel, afterLabel].compactMap { $0 }.joined(separator: " | ")
                return SwitchMarker(date: date, label: label, beforeLabel: beforeLabel, afterLabel: afterLabel)
            }
        }

        var axisDates: [Date] {
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            let ends = [now.addingTimeInterval(duration), comparison.recommendedEnd]
            let dates = Set([now] + ends + comparison.periodSwitches)
            return dates.filter { $0 >= now && $0 <= comparison.horizonEnd }.sorted()
        }

        var percentLess: String? {
            guard claimsSaving, comparison.costNow > 0 else { return nil }
            let percent = Int(((comparison.costNow - comparison.recommendedCost) / comparison.costNow * 100).rounded())
            return percent > 0 ? "\(percent)% less" : nil
        }

        var why: String {
            if isNow {
                guard let key = periodKey(at: now) else { return "" }
                let period = name(key)
                // Priced, like the cost, against each bank at the projection end, not today's.
                let draws = nowDraws
                let total = draws.reduce(0) { $0 + $1.kwh }
                let covered = draws.reduce(0) { $0 + $1.fromBank }
                guard roundedKwh(covered) > 0 else { return "It's \(period); this run is bought at the full rate." }
                let share = total <= 0 || covered >= total - 0.05 ? "all" : covered / total >= 0.5 ? "most" : "some"
                let banks = draws.count > 1 ? "your banks cover" : "your \(period) bank covers"
                return "It's \(period), and \(banks) \(share) of this run."
            }
            let nowDraws = self.nowDraws
            let laterDraws = self.laterDraws
            let time = when(comparison.recommendedStart)
            if case .nowUnsafe(let key) = comparison.safety {
                let warning = "Starting now would draw on your \(name(key)) bank, which a cloudy week could leave more than "
                    + "\(shortfallKwh) kWh short by \(shortDate(comparison.safetyEnd))."
                guard let laterMain = laterDraws.max(by: { $0.kwh < $1.kwh }) else { return warning }
                return warning + " " + laterClause(laterMain, total: laterDraws.reduce(0) { $0 + $1.kwh }, time: time)
            }
            guard let nowMain = nowDraws.max(by: { $0.kwh < $1.kwh }),
                  let laterMain = laterDraws.max(by: { $0.kwh < $1.kwh }) else {
                return "Starting \(time) costs less than starting now."
            }
            if nowMain.key != laterMain.key {
                return nowClause(nowMain, crossesPeriods: nowDraws.count > 1) + " "
                    + laterClause(laterMain, total: laterDraws.reduce(0) { $0 + $1.kwh }, time: time)
            }
            // Both runs lean on the same period, so the saving comes from how the
            // energy splits: name the period starting now puts more into.
            let laterKwh = Dictionary(uniqueKeysWithValues: laterDraws.map { ($0.key, $0.kwh) })
            if let heavier = nowDraws
                .map({ (key: $0.key, extra: $0.kwh - (laterKwh[$0.key] ?? 0)) })
                .filter({ $0.extra > 0.000_001 })
                .max(by: { $0.extra < $1.extra })?.key {
                return "Starting now puts more of it in \(name(heavier)), where you \(bankPhrase(heavier)). "
                    + "Run \(time) so less of it lands there."
            }
            return "Starting \(time) costs less than starting now."
        }

        func rateValue(_ key: String, sell: Bool) -> Double? {
            let segment = timing.tariffTimeline.first { $0.periodKey == key }
            return sell ? segment?.sellRate : segment?.buyRate
        }

        func rate(_ key: String, sell: Bool) -> String {
            DashboardPresentation.loadRate(rateValue(key, sell: sell), code: currencyCode)
        }

        /// Starting now's draws, against each bank at the projection end.
        var nowDraws: [Draw] {
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            return draws(from: now, to: now.addingTimeInterval(duration), profile: profile, timing: timing,
                         laneEnd: { $0.projectedAfterStartNowKwh }, lanes: comparison.lanes)
        }

        /// The recommended start's draws, against each bank at the projection end.
        var laterDraws: [Draw] {
            draws(from: comparison.recommendedStart, to: comparison.recommendedEnd, profile: profile, timing: timing,
                  laneEnd: { $0.projectedAfterRecommendedKwh }, lanes: comparison.lanes)
        }

        var costBreakdowns: [CostBreakdown] {
            let startNow = breakdown(title: nowLabel, total: comparison.costNow, draws: nowDraws)
            guard !isNow else { return [startNow] }
            let later = breakdown(title: "\(verb) \(when(comparison.recommendedStart))", total: comparison.recommendedCost,
                                  draws: laterDraws)
            return [later, startNow]
        }

        /// "by Nov 10 (bill date)", "by Nov 1, when rates change," or "by Oct 20".
        var projectionEndPhrase: String {
            let date = shortDate(comparison.projectionEnd)
            if comparison.projectionEndsAtRateChange { return "by \(date), when rates change," }
            if let billingCycleEnd, comparison.projectionEnd == billingCycleEnd { return "by \(date) (bill date)," }
            return "by \(date),"
        }

        func breakdown(title: String, total: Double, draws: [Draw]) -> CostBreakdown {
            let kwh: (Double) -> String = { $0.formatted(.number.precision(.fractionLength(1))) }
            var lines: [CostLine] = []
            var notes: [String] = []
            for draw in draws {
                let period = name(draw.key)
                let bought = draw.kwh - draw.fromBank
                if draw.fromBank >= 0.05 {
                    lines.append(CostLine(period: period, detail: "\(kwh(draw.fromBank)) kWh from your bank × \(rate(draw.key, sell: true)) credit",
                                          amount: money(draw.fromBank * (rateValue(draw.key, sell: true) ?? 0))))
                    if let projected = draw.bankWithoutRun {
                        let today = startKwh(draw.key) ?? 0
                        notes.append("\(period) bank is \(signedKwh(today)) now, projecting \(signedKwh(projected)) "
                            + "\(projectionEndPhrase) \(signedKwh(projected - draw.kwh)) after this charge.")
                    }
                }
                if bought >= 0.05 {
                    lines.append(CostLine(period: period, detail: "\(kwh(bought)) kWh bought × \(rate(draw.key, sell: false))",
                                          amount: money(bought * (rateValue(draw.key, sell: false) ?? 0))))
                }
            }
            return CostBreakdown(title: title, total: money(total), lines: lines, notes: notes)
        }

        /// Why starting now costs what it does: bought at the period's rate, or its bank's credit given up.
        func nowClause(_ draw: Draw, crossesPeriods: Bool) -> String {
            let period = name(draw.key)
            if draw.fromBank >= draw.kwh / 2 {
                return "Starting now uses your \(period) bank, giving up \(rate(draw.key, sell: true)) in credit."
            }
            let bought = draw.fromBank > 0.05 ? "most of it is bought" : "it's bought"
            return "Starting now runs \(crossesPeriods ? "into" : "during") \(period), where you \(bankPhrase(draw.key)), "
                + "so \(bought) at \(rate(draw.key, sell: false))."
        }

        /// What the later start uses instead. A bank larger than today's means the
        /// forecast expects solar to fill it before the run.
        func laterClause(_ draw: Draw, total: Double, time: String) -> String {
            let period = name(draw.key)
            let mostly = total > 0 && draw.kwh / total < 0.95 ? "mostly " : ""
            guard draw.fromBank >= draw.kwh / 2 else {
                return "\(capitalized(time)) it's \(mostly)bought at the \(period) rate of \(rate(draw.key, sell: false))."
            }
            // A bank larger than today's is filled by projected solar across the
            // days to the projection end, not by tomorrow alone, so say where it stands then.
            let projected = draw.fromBank > max(startKwh(draw.key) ?? 0, 0) + 0.5
                ? draw.bankWithoutRun.map { ", projected at \(signedKwh($0)) kWh by \(shortDate(comparison.projectionEnd))" } ?? ""
                : ""
            return "\(capitalized(time)) it \(mostly)uses your \(period) bank\(projected), giving up \(rate(draw.key, sell: true)) in credit."
        }

        func lane(_ lane: LoadTimingForecastEstimator.BalanceLane) -> LaneDisplay {
            let laterEnd = lane.recommended.last?.kwh ?? lane.startKwh
            let nowEnd = lane.startNow.last?.kwh ?? lane.startKwh
            let endLabels = isNow || signedKwh(laterEnd) == signedKwh(nowEnd)
                ? [signedKwh(laterEnd)]
                : [signedKwh(laterEnd), signedKwh(nowEnd)]
            return LaneDisplay(
                title: "\(name(lane.periodKey)) bank (kWh)",
                startLabel: startLabel(lane.startKwh),
                recommended: lane.recommended,
                startNow: isNow ? nil : lane.startNow,
                endLabels: endLabels,
                switches: switchMarkers
            )
        }

        func notes(forecast: ForecastAvailability) -> [SmartShiftVerdict.Note] {
            var notes: [SmartShiftVerdict.Note]
            switch forecast {
            case .none: notes = [.connectSolcast(usesHistory: comparison.usesHistory)]
            case .loading: notes = [.forecastState(checkingSolarNote)]
            case .unusable(let message): notes = [.forecastState(message)]
            case .ready: notes = []
            }
            if comparison.hasUnobservedBalance { notes.append(.unobservedBalance) }
            return notes
        }

        var accessibilitySummary: String {
            comparison.lanes.map { lane in
                let period = name(lane.periodKey)
                let start = startLabel(lane.startKwh)
                let nowEnd = spokenBalance(lane.startNow.last?.kwh ?? lane.startKwh)
                if isNow {
                    return "\(period) bank: \(start); \(nowLabel.lowercased()) leaves \(nowEnd)."
                }
                let laterEnd = spokenBalance(lane.recommended.last?.kwh ?? lane.startKwh)
                return "\(period) bank: \(start); \(laterLabel.lowercased()) leaves \(laterEnd), "
                    + "\(nowLabel.lowercased()) leaves \(nowEnd)."
            }.joined(separator: " ")
        }
    }
}
