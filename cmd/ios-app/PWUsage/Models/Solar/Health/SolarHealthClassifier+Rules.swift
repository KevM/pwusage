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
        let isGradual: Bool
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
            let segments = combinedShadeSegments(from: latest.map.mask)
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

    private static func combinedShadeSegments(from mask: ShadeMask) -> [ShadeSegment] {
        var segments = mask.summary()
        for hot in mask.hotBins {
            let covered = segments.contains {
                hot.azimuth >= $0.azimuthFrom && hot.azimuth < $0.azimuthTo && hot.elevation <= $0.belowElevation
            }
            if !covered {
                segments.append(ShadeSegment(
                    azimuthFrom: hot.azimuth, azimuthTo: hot.azimuth + 10, belowElevation: hot.elevation + 5))
            }
        }
        return segments
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
            let delta: Double
            if oldEl.isFinite {
                delta = newEl - oldEl
            } else {
                let observed = previous.map.observedBins ?? []
                guard observed.indices.contains(bin), observed[bin] else { continue }
                delta = newEl
            }
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

    static func analyzeSoiling(from years: [SolarHealthYear], rainDays: Set<String> = []) -> SoilingAnalysis {
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
                // Daily totals cannot establish whether it rained before a reading on the same day.
                let recovery = rainDays.contains { prev.day < $0 && $0 < curr.day }
                    ? "and recovered on \(curr.day) after rain."
                    : "and recovered on \(curr.day)."
                findings.append(SolarHealthFinding(
                    id: "soiling-\(curr.day)",
                    kind: .soiling,
                    title: "Dirt or pollen reduced output before recovering",
                    detail: "Clear-day output trended down by about \(Int((run.drop * 100).rounded()))% "
                        + recovery,
                    clearDays: run.count,
                    confidence: run.count >= 7 ? .confident : .initial,
                    meetsMinimumEvidence: run.count >= minSoilingClearDays,
                    season: nil,
                    azimuthFrom: nil,
                    azimuthTo: nil))
            }
        }

        let dirtLevel = activeDirtLevel(
            in: ratios, lastRecoveryIndex: lastRecoveryIndex, lastRecoveredDay: lastRecoveredDay)
        return SoilingAnalysis(dirtLevel: dirtLevel, findings: findings)
    }

    private static func activeDirtLevel(
        in ratios: [SolarDailyRatio], lastRecoveryIndex: Int, lastRecoveredDay: String?
    ) -> SolarHealthReport.DirtLevel {
        let stepIndex = bestStepFault(in: ratios)?.index ?? 0
        let tailStart = max(lastRecoveryIndex, stepIndex)
        let tail = Array(ratios[tailStart...])
        let baselineSource = tailStart > lastRecoveryIndex ? tail : ratios
        let baseline = quantile(baselineSource.map(\.ratio), 0.9)
        let recent = median(tail.suffix(3).map(\.ratio))
        let tailRun = decliningRun(in: tail, from: 0, endingAt: tail.count - 1)
        let activeLoss = (baseline.isFinite && recent.isFinite && baseline > 0 && tailRun.count >= 3)
            ? max(0, (baseline - recent) / baseline * 100) : 0
        let isActive = activeLoss >= 2.0 && tailRun.slope < 0 && tailRun.isGradual
        return .init(
            currentLossPercent: isActive ? (activeLoss * 10).rounded() / 10 : nil,
            lastRecoveredDay: lastRecoveredDay,
            isActive: isActive)
    }

    private static func decliningRun(
        in ratios: [SolarDailyRatio], from start: Int, endingAt end: Int
    ) -> DecliningRun {
        guard end > start else {
            return DecliningRun(count: end - start + 1, drop: 0, slope: 0, isGradual: false)
        }
        var peakIndex = start
        for idx in start ... end where ratios[idx].ratio >= ratios[peakIndex].ratio {
            peakIndex = idx
        }
        let slice = Array(ratios[peakIndex ... end])
        guard slice.count >= 2 else {
            return DecliningRun(count: slice.count, drop: 0, slope: 0, isGradual: false)
        }
        let drop = ratios[peakIndex].ratio - ratios[end].ratio
        let slope = linearSlope(slice.map(\.ratio))
        let declineSteps = zip(slice, slice.dropFirst()).count { $0.1.ratio < $0.0.ratio - 0.002 }
        return DecliningRun(count: slice.count, drop: drop, slope: slope, isGradual: declineSteps >= 2)
    }

    // MARK: - Step Fault

    private static func bestStepFault(in ratios: [SolarDailyRatio]) -> StepFaultMatch? {
        guard ratios.count >= 6 else { return nil }
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
        return best
    }

    static func analyzeStepFault(from years: [SolarHealthYear]) -> [SolarHealthFinding] {
        guard let ratios = years.last?.dailyRatios,
              let match = bestStepFault(in: ratios) else { return [] }
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
