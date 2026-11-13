import Foundation

/// Pure classification of `SolarHealthResult` into plain-language findings and health stats.
enum SolarHealthClassifier {
    static let minSoilingClearDays = 5
    static let minSoilingStep = 0.02
    static let minStepFaultDrop = 0.10
    static let stepFaultStayMargin = 0.08
    static let minStepFaultClearDays = 3
    static let minShadeGrowthDegrees = 5.0
    static let minAgingMonthsInitial = 13
    static let minAgingMonthsConfident = 24
    /// Matched-month pairs, and distinct calendar months among them, each confidence level needs.
    static let minAgingPairsInitial = 3
    static let minAgingPairMonthsInitial = 2
    static let minAgingPairsConfident = 6
    static let minAgingPairMonthsConfident = 3
    static let expectedAnnualAgingPercent = -0.5
    static let agingFindingThresholdPercent = -0.8
    static let capacityStepUpThreshold = 0.08
    static let healthyScoreBandPercent = 8.0
    static let lowOutputThreshold = 0.85

    static func classify(
        _ result: SolarHealthResult, manual: ManualSolarLayout? = nil, now: Date = .now, rainDays: Set<String> = []
    ) -> SolarHealthReport {
        let potential = potentialVsActual(from: result.years)
        let score = healthScore(from: result, manual: manual, now: now)
        let shadeAnalysis = analyzeShading(from: result.years)
        let soilingAnalysis = analyzeSoiling(from: result.years, rainDays: rainDays)
        let faultFindings = analyzeStepFault(from: result.years)
        let changeAnalysis = analyzeChangeOverTime(from: result, manual: manual, now: now)

        var findings: [SolarHealthFinding] = []
        if let score, score.factor < lowOutputThreshold, score.clearDays >= SolarHealthYearFit.minYearClearDays {
            findings.append(lowOutputFinding(score: score))
        }
        findings.append(contentsOf: faultFindings)
        findings.append(contentsOf: shadeAnalysis.findings)
        findings.append(contentsOf: soilingAnalysis.findings)
        if let agingFinding = changeAnalysis.finding { findings.append(agingFinding) }

        return SolarHealthReport(
            source: result.reference.source,
            potentialVsActual: potential,
            healthScore: score,
            shading: shadeAnalysis.summary,
            dirtLevel: soilingAnalysis.dirtLevel,
            changeOverTime: changeAnalysis.change,
            dailyRatios: result.years.last?.dailyRatios ?? [],
            allFindings: findings)
    }

    private static func potentialVsActual(from years: [SolarHealthYear]) -> SolarHealthReport.PotentialVsActual? {
        for year in years.reversed() {
            if let latest = year.dailyRatios.last(where: { $0.expectedKwh != nil && $0.actualKwh != nil }),
               let expected = latest.expectedKwh, let actual = latest.actualKwh {
                return SolarHealthReport.PotentialVsActual(
                    day: latest.day, expectedKwh: expected, actualKwh: actual)
            }
        }
        return nil
    }

    private static func healthScore(
        from result: SolarHealthResult, manual: ManualSolarLayout?, now: Date
    ) -> SolarHealthReport.HealthScore? {
        guard result.reference.source == .manual, let manual else { return nil }
        let nameplate = manual.nameplateKw(on: now)
        guard nameplate > 0,
              let latest = result.years.last(where: { $0.capacity != nil }),
              let capacity = latest.capacity else { return nil }
        return SolarHealthReport.HealthScore(
            factor: capacity.site,
            nameplateKw: nameplate,
            impliedKw: nameplate * capacity.site,
            bandPercent: healthyScoreBandPercent,
            perDirection: capacity.directions,
            clearDays: capacity.clearDays)
    }

    private static func lowOutputFinding(score: SolarHealthReport.HealthScore) -> SolarHealthFinding {
        let percent = Int((score.factor * 100).rounded())
        return SolarHealthFinding(
            id: "low-output",
            kind: .lowOutput,
            title: "Output below expected for panel size",
            detail: "Clear-day output is about \(percent)% of what your entered panels should produce.",
            clearDays: score.clearDays,
            confidence: score.clearDays >= 20 ? .confident : .initial,
            meetsMinimumEvidence: true,
            season: nil,
            azimuthFrom: nil,
            azimuthTo: nil)
    }
}
