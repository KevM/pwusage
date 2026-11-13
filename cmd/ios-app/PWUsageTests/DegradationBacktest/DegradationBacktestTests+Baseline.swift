import Foundation
@testable import PWUsage

extension DegradationBacktestTests {
    // MARK: - 5. Site baseline

    static func baselineSection(_ inputs: DegradationBacktestInputs, result: SolarHealthResult) -> [String] {
        let report = SolarHealthClassifier.classify(
            result,
            manual: inputs.config.manual,
            now: inputs.config.now,
            rainDays: inputs.rainDays)
        guard let score = report.healthScore else {
            return ["## 5. Site baseline", "", "No site baseline.", ""]
        }

        let baseline = score.baseline
        let windowStart = String(format: "%04d-%02d", baseline.windowStart.year, baseline.windowStart.month)
        let perFace = score.perDirection.isEmpty
            ? "none"
            : score.perDirection
            .map { String(format: "%.0f° %.1f%%", $0.azimuth, $0.factor * 100) }
            .joined(separator: ", ")

        var lines = [
            "## 5. Site baseline",
            "",
            "- Window start: \(windowStart)",
            "- Provisional: \(baseline.isProvisional ? "yes" : "no")",
            "- Seasons covered: \(baseline.seasonsCovered)",
            String(format: "- Rated efficiency: %.1f%%", score.ratedEfficiency * 100),
            String(format: "- Score vs new: %.1f%%", score.scoreVsNew * 100),
            "- Per-face score: \(perFace)"
        ]
        if let restartYear = baseline.restartYear {
            lines.append("- Restart year: \(restartYear)")
        }
        return lines + [""]
    }
}
