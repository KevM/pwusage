import Foundation

extension SolarHealthClassifier {
    // MARK: - Shading & Shading Growth

    struct ShadeAnalysis {
        let summary: SolarHealthReport.ShadingSummary
        let findings: [SolarHealthFinding]
    }

    private struct AzimuthRange {
        let from: Double
        var upper: Double
    }

    private struct DecliningRun {
        let count: Int
        let drop: Double
        let slope: Double
    }

    private struct StepFaultMatch {
        let index: Int
        let drop: Double
        let afterCount: Int
    }

    static func analyzeShading(from years: [SolarHealthYear]) -> ShadeAnalysis {
        var latestBySeason: [SolarSeason: SolarSeasonShade] = [:]
        var allBySeason: [SolarSeason: [(year: Int, shade: SolarSeasonShade)]] = [:]
        for year in years {
            for entry in year.shade {
                latestBySeason[entry.season] = entry
                allBySeason[entry.season, default: []].append((year.year, entry))
            }
        }

        var entries: [SolarHealthShadingEntry] = []
        var findings: [SolarHealthFinding] = []
        for season in SolarSeason.allCases {
            guard let latest = latestBySeason[season] else { continue }
            let segments = latest.map.mask.summary()
            guard !segments.isEmpty else { continue }
            let growth = grownRanges(for: season, history: allBySeason[season] ?? [])
            for segment in segments {
                let grew = growth.contains {
                    $0.from < segment.azimuthTo && $0.upper > segment.azimuthFrom
                }
                entries.append(SolarHealthShadingEntry(
                    season: season,
                    azimuthFrom: segment.azimuthFrom,
                    azimuthTo: segment.azimuthTo,
                    maxElevation: segment.belowElevation,
                    clearDays: latest.clearDays,
                    grew: grew))
            }
            if let primary = segments.max(by: {
                ($0.azimuthTo - $0.azimuthFrom) < ($1.azimuthTo - $1.azimuthFrom)
            }) {
                findings.append(shadingFinding(
                    season: season, segment: primary, clearDays: latest.clearDays))
            }
            if let grown = growth.first {
                findings.append(shadingGrowthFinding(
                    season: season, from: grown.from, upper: grown.upper, clearDays: latest.clearDays))
            }
        }
        return ShadeAnalysis(summary: .init(entries: entries), findings: findings)
    }

    private static func grownRanges(
        for season: SolarSeason, history: [(year: Int, shade: SolarSeasonShade)]
    ) -> [AzimuthRange] {
        guard history.count >= 2,
              let previous = history.first?.shade,
              let latest = history.last?.shade else { return [] }
        let count = min(previous.map.horizon.count, latest.map.horizon.count)
        var grownBins: [Int] = []
        for bin in 0 ..< count {
            let newEl = latest.map.horizon[bin]
            let oldEl = previous.map.horizon[bin]
            guard newEl.isFinite, newEl >= minShadeGrowthDegrees else { continue }
            let delta = oldEl.isFinite ? newEl - oldEl : newEl
            if delta >= minShadeGrowthDegrees { grownBins.append(bin) }
        }
        var ranges: [AzimuthRange] = []
        for bin in grownBins {
            let binFrom = Double(bin * 10)
            let binTo = Double((bin + 1) * 10)
            if let last = ranges.last, last.upper == binFrom {
                ranges[ranges.count - 1].upper = binTo
            } else {
                ranges.append(AzimuthRange(from: binFrom, upper: binTo))
            }
        }
        return ranges
    }

    private static func shadingFinding(
        season: SolarSeason, segment: ShadeSegment, clearDays: Int
    ) -> SolarHealthFinding {
        let direction = compassDescription(from: segment.azimuthFrom, upper: segment.azimuthTo)
        let evidence = clearDays >= SolarHealthYearFit.minSeasonClearDays
        return SolarHealthFinding(
            id: "shading-\(season.rawValue)-\(Int(segment.azimuthFrom))",
            kind: .shading,
            title: "\(season.capitalizedName) shading from the \(direction)",
            detail: "Output is lower in \(season.displayName) when the sun is low in the \(direction) "
                + "(\(Int(segment.azimuthFrom))°–\(Int(segment.azimuthTo))°), consistent with shading.",
            clearDays: clearDays,
            confidence: clearDays >= 10 ? .confident : .initial,
            meetsMinimumEvidence: evidence,
            season: season,
            azimuthFrom: segment.azimuthFrom,
            azimuthTo: segment.azimuthTo)
    }

    private static func shadingGrowthFinding(
        season: SolarSeason, from: Double, upper: Double, clearDays: Int
    ) -> SolarHealthFinding {
        let direction = compassDescription(from: from, upper: upper)
        let evidence = clearDays >= SolarHealthYearFit.minSeasonClearDays
        return SolarHealthFinding(
            id: "shading-growth-\(season.rawValue)-\(Int(from))",
            kind: .shadingGrowth,
            title: "Shading grew in \(season.displayName)",
            detail: "Shading from the \(direction) (\(Int(from))°–\(Int(upper))°) is at least 5° higher "
                + "than in an earlier \(season.displayName).",
            clearDays: clearDays,
            confidence: .confident,
            meetsMinimumEvidence: evidence,
            season: season,
            azimuthFrom: from,
            azimuthTo: upper)
    }

    // MARK: - Soiling

    struct SoilingAnalysis {
        let dirtLevel: SolarHealthReport.DirtLevel
        let findings: [SolarHealthFinding]
    }

    static func analyzeSoiling(from years: [SolarHealthYear]) -> SoilingAnalysis {
        guard let currentYear = years.last else {
            return SoilingAnalysis(
                dirtLevel: .init(currentLossPercent: nil, lastRecoveredDay: nil, isActive: false),
                findings: [])
        }
        let ratios = currentYear.dailyRatios
        guard ratios.count >= 2 else {
            return SoilingAnalysis(
                dirtLevel: .init(currentLossPercent: nil, lastRecoveredDay: nil, isActive: false),
                findings: [])
        }
        var findings: [SolarHealthFinding] = []
        var lastRecoveredDay: String?
        var lastRecoveryIndex = 0

        for index in 1 ..< ratios.count {
            let prev = ratios[index - 1]
            let curr = ratios[index]
            guard daysBetween(prev.day, curr.day) > 1,
                  curr.ratio - prev.ratio >= minSoilingStep else { continue }
            let run = decliningRun(in: ratios, from: lastRecoveryIndex, endingAt: index - 1)
            if run.drop >= minSoilingStep, run.slope < 0 {
                lastRecoveredDay = curr.day
                lastRecoveryIndex = index
                findings.append(SolarHealthFinding(
                    id: "soiling-\(curr.day)",
                    kind: .soiling,
                    title: "Dirt or pollen reduced output before recovering",
                    detail: "Clear-day output trended down by about \(Int((run.drop * 100).rounded()))% "
                        + "and recovered on \(curr.day).",
                    clearDays: run.count,
                    confidence: run.count >= 7 ? .confident : .initial,
                    meetsMinimumEvidence: run.count >= minSoilingClearDays,
                    season: nil,
                    azimuthFrom: nil,
                    azimuthTo: nil))
            }
        }

        let tail = Array(ratios[lastRecoveryIndex...])
        let baseline = quantile(ratios.map(\.ratio), 0.9)
        let recent = median(tail.suffix(3).map(\.ratio))
        let tailRun = decliningRun(in: tail, from: 0, endingAt: tail.count - 1)
        let activeLoss = (baseline.isFinite && recent.isFinite && baseline > 0 && tailRun.count >= 3)
            ? max(0, (baseline - recent) / baseline * 100) : 0
        let isActive = activeLoss >= 2.0 && tailRun.slope < 0
        return SoilingAnalysis(
            dirtLevel: .init(
                currentLossPercent: isActive ? (activeLoss * 10).rounded() / 10 : nil,
                lastRecoveredDay: lastRecoveredDay,
                isActive: isActive),
            findings: findings)
    }

    private static func decliningRun(
        in ratios: [SolarDailyRatio], from start: Int, endingAt end: Int
    ) -> DecliningRun {
        guard end > start else { return DecliningRun(count: end - start + 1, drop: 0, slope: 0) }
        var peakIndex = start
        for idx in start ... end where ratios[idx].ratio >= ratios[peakIndex].ratio {
            peakIndex = idx
        }
        let slice = Array(ratios[peakIndex ... end])
        guard slice.count >= 2 else { return DecliningRun(count: slice.count, drop: 0, slope: 0) }
        let drop = ratios[peakIndex].ratio - ratios[end].ratio
        let slope = linearSlope(slice.map(\.ratio))
        return DecliningRun(count: slice.count, drop: drop, slope: slope)
    }

    // MARK: - Step Fault

    static func analyzeStepFault(from years: [SolarHealthYear]) -> [SolarHealthFinding] {
        guard let ratios = years.last?.dailyRatios, ratios.count >= 6 else { return [] }
        var best: StepFaultMatch?
        for index in 3 ... (ratios.count - minStepFaultClearDays) {
            let beforeStart = max(0, index - 10)
            let before = median(ratios[beforeStart ..< index].map(\.ratio))
            let afterSlice = ratios[index ..< ratios.count]
            let after = median(afterSlice.map(\.ratio))
            guard before.isFinite, after.isFinite else { continue }
            let drop = before - after
            let staysDown = afterSlice.allSatisfy { $0.ratio <= before - stepFaultStayMargin }
            if drop >= minStepFaultDrop, staysDown, best.map({ drop > $0.drop }) ?? true {
                best = StepFaultMatch(index: index, drop: drop, afterCount: ratios.count - index)
            }
        }
        guard let match = best else { return [] }
        let day = ratios[match.index].day
        let percent = Int((match.drop * 100).rounded())
        return [SolarHealthFinding(
            id: "step-fault-\(day)",
            kind: .stepFault,
            title: "Sudden output drop",
            detail: "Clear-day output dropped by about \(percent)% starting \(day) and has stayed down.",
            clearDays: match.afterCount,
            confidence: match.afterCount >= 5 ? .confident : .initial,
            meetsMinimumEvidence: match.afterCount >= minStepFaultClearDays,
            season: nil,
            azimuthFrom: nil,
            azimuthTo: nil)]
    }

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
        let rate = medianAnnualChange(from: trendMonths)
        let confidence: SolarHealthConfidence? = span >= minAgingMonthsConfident
            ? .confident : (span >= minAgingMonthsInitial ? .initial : nil)
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

    private static func medianAnnualChange(
        from months: [SolarHealthMonthEntry]
    ) -> Double? {
        var byMonth: [Int: [SolarHealthMonthEntry]] = [:]
        for entry in months { byMonth[entry.month, default: []].append(entry) }
        var changes: [Double] = []
        for (_, entries) in byMonth {
            let sorted = entries.sorted { $0.year < $1.year }
            for idx in 1 ..< sorted.count {
                let prev = sorted[idx - 1]
                let curr = sorted[idx]
                let yearsApart = Double(curr.year - prev.year)
                guard prev.factor > 0, yearsApart > 0 else { continue }
                changes.append(((curr.factor - prev.factor) / prev.factor) / yearsApart * 100.0)
            }
        }
        let med = median(changes)
        return med.isFinite ? (med * 100).rounded() / 100 : nil
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

    // MARK: - Helpers

    private static func linearSlope(_ values: [Double]) -> Double {
        let count = Double(values.count)
        guard count >= 2 else { return 0 }
        let meanX = (count - 1) / 2
        let meanY = values.reduce(0, +) / count
        var num = 0.0
        var den = 0.0
        for (idx, val) in values.enumerated() {
            let deltaX = Double(idx) - meanX
            num += deltaX * (val - meanY)
            den += deltaX * deltaX
        }
        return den > 0 ? num / den : 0
    }

    private static func daysBetween(_ start: String, _ end: String) -> Int {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .gmt
        formatter.dateFormat = "yyyy-MM-dd"
        guard let startDate = formatter.date(from: start),
              let endDate = formatter.date(from: end) else { return 0 }
        return Int((endDate.timeIntervalSince(startDate) / 86_400).rounded())
    }

    private static func compassDescription(from: Double, upper: Double) -> String {
        let mid = (from + upper) / 2
        switch LayoutFit.wrapDegrees(mid) {
        case 22.5 ..< 67.5: return "northeast"
        case 67.5 ..< 112.5: return "east"
        case 112.5 ..< 157.5: return "southeast"
        case 157.5 ..< 202.5: return "south"
        case 202.5 ..< 247.5: return "southwest"
        case 247.5 ..< 292.5: return "west"
        case 292.5 ..< 337.5: return "northwest"
        default: return "north"
        }
    }
}
