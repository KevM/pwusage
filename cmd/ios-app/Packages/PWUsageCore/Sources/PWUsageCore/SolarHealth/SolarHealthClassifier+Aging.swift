import Foundation

extension SolarHealthClassifier {
    // MARK: - Aging & Change Over Time

    struct ChangeAnalysis {
        let change: SolarHealthReport.ChangeOverTime
        let finding: SolarHealthFinding?
    }

    static func analyzeChangeOverTime(
        from result: SolarHealthResult, manual: ManualSolarLayout?, now: Date
    ) -> ChangeAnalysis {
        let yearEntries = result.years.compactMap { year -> SolarHealthYearEntry? in
            guard let cap = year.capacity else { return nil }
            return SolarHealthYearEntry(year: year.year, factor: cap.site, clearDays: cap.clearDays)
        }
        let monthEntries = result.years.flatMap { year in
            year.months.map {
                SolarHealthMonthEntry(
                    year: year.year, month: $0.month, factor: $0.capacity.site, clearDays: $0.capacity.clearDays)
            }
        }
        let trendStartYear = trendStart(years: yearEntries, source: result.reference.source)
        let trendMonths = monthEntries.filter { $0.year >= trendStartYear }
        let span = monthSpan(trendMonths)
        let changes = annualChanges(from: trendMonths)
        let middle = median(changes.map(\.percent))
        let rate = middle.isFinite ? (middle * 100).rounded() / 100 : nil
        let confidence = agingConfidence(span: span, changes: changes)
        let expected = expectedAgingRate(manual: manual, now: now)
        let change = SolarHealthReport.ChangeOverTime(
            years: yearEntries,
            months: monthEntries,
            agingPercentPerYear: rate,
            expectedAgingPercentPerYear: expected,
            agingConfidence: confidence,
            hasEnoughHistoryForTrend: yearEntries.count >= 2 || span >= minAgingMonthsInitial)

        var finding: SolarHealthFinding?
        if let rate, let confidence, rate <= agingFindingThresholdPercent {
            let clearDays = trendMonths.reduce(0) { $0 + $1.clearDays }
            let formatted = String(format: "%.1f", abs(rate))
            finding = SolarHealthFinding(
                id: "aging",
                kind: .aging,
                title: "Gradual output decline",
                detail: "Output has declined by about \(formatted)% per year across matching months.",
                clearDays: clearDays,
                confidence: confidence,
                meetsMinimumEvidence: span >= minAgingMonthsInitial,
                season: nil,
                azimuthFrom: nil,
                azimuthTo: nil)
        }
        return ChangeAnalysis(change: change, finding: finding)
    }

    private static func trendStart(
        years: [SolarHealthYearEntry], source: SolarHealthReference.Source
    ) -> Int {
        guard source == .detected, years.count >= 2 else { return years.first?.year ?? 0 }
        var start = years[0].year
        for idx in 1 ..< years.count where years[idx].factor - years[idx - 1].factor > capacityStepUpThreshold {
            start = years[idx].year
        }
        return start
    }

    private static func monthSpan(_ months: [SolarHealthMonthEntry]) -> Int {
        guard let first = months.first, let last = months.last else { return 0 }
        return (last.year - first.year) * 12 + (last.month - first.month) + 1
    }

    /// One annualized change between successive observations of the same calendar month.
    struct MatchedChange: Equatable {
        let month: Int
        let percent: Double
    }

    /// Every matched-month change: successive observations of one calendar month, in %/yr.
    static func annualChanges(from months: [SolarHealthMonthEntry]) -> [MatchedChange] {
        var byMonth: [Int: [SolarHealthMonthEntry]] = [:]
        for entry in months { byMonth[entry.month, default: []].append(entry) }
        var changes: [MatchedChange] = []
        for (month, entries) in byMonth {
            let sorted = entries.sorted { $0.year < $1.year }
            for idx in 1 ..< sorted.count {
                let prev = sorted[idx - 1]
                let curr = sorted[idx]
                let yearsApart = Double(curr.year - prev.year)
                guard prev.factor > 0, yearsApart > 0 else { continue }
                changes.append(MatchedChange(
                    month: month, percent: ((curr.factor - prev.factor) / prev.factor) / yearsApart * 100.0))
            }
        }
        return changes
    }

    /// A long span is not enough on its own: a median of one or two pairs follows a single odd
    /// season, so each level also needs enough pairs spread over enough calendar months.
    private static func agingConfidence(span: Int, changes: [MatchedChange]) -> SolarHealthConfidence? {
        let months = Set(changes.map(\.month)).count
        if span >= minAgingMonthsConfident, changes.count >= minAgingPairsConfident,
           months >= minAgingPairMonthsConfident {
            return .confident
        }
        if span >= minAgingMonthsInitial, changes.count >= minAgingPairsInitial, months >= minAgingPairMonthsInitial {
            return .initial
        }
        return nil
    }

    private static func expectedAgingRate(manual: ManualSolarLayout?, now: Date) -> Double? {
        guard let manual else { return nil }
        let total = manual.nameplateKw(on: now)
        guard total > 0 else { return nil }
        let agedKw = manual.systems.reduce(0.0) { sum, system in
            guard let install = system.installDate, install <= now else { return sum }
            return sum + system.faces.reduce(0.0) { $0 + $1.nameplateKw }
        }
        guard agedKw > 0 else { return nil }
        return (expectedAnnualAgingPercent * (agedKw / total) * 100).rounded() / 100
    }
}
