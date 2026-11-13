import SwiftUI

/// Health stats, capacity score, ratio trend link and plain-language findings for Solar System.
struct SolarHealthSection: View {
    let report: SolarHealthReport
    let isLoading: Bool
    var usedWeather = false
    var onEditLayout: () -> Void = {}
    var onLoadMoreHistory: (() -> Void)?

    var body: some View {
        healthCardSection
        statsSection
        findingsSection
    }

    private var healthCardSection: some View {
        Section {
            if let score = report.healthScore {
                healthScoreRows(score)
            } else {
                manualPromptRow
            }
            if !report.changeOverTime.months.isEmpty || !report.dailyRatios.isEmpty {
                NavigationLink("Capacity & Ratio Trend") {
                    SolarHealthTrendView(report: report)
                }
            }
        } header: {
            HStack {
                Text("Panel Health")
                if isLoading {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder
    private func healthScoreRows(_ score: SolarHealthReport.HealthScore) -> some View {
        let percent = Int((score.scoreVsNew * 100).rounded())
        let band = Int(score.bandPercent.rounded())
        LabeledContent("Health score") {
            Text("\(percent)% (±\(band)%)")
                .fontWeight(.semibold)
                .foregroundStyle(score.isBelowBand ? Color.emphasis : Color.primary)
        }
        LabeledContent(
            "Entered capacity",
            value: SolarSystemDetailsRows.kilowatts(score.nameplateKw))
        if score.perDirection.count > 1 {
            ForEach(score.perDirection, id: \.azimuth) { direction in
                LabeledContent(
                    SolarSystemDetailsRows.direction(direction.azimuth),
                    value: "\(Int((direction.factor * 100).rounded()))%")
            }
        }
    }

    private var manualPromptRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter your panel count and wattage to see your absolute health score and expected "
                + "clear-day energy.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Add Panel Details", action: onEditLayout)
                .font(.subheadline.weight(.medium))
        }
    }

    private var statsSection: some View {
        Section("Health Stats") {
            potentialRow
            shadingRow
            dirtRow
            changeRow
        }
    }

    @ViewBuilder private var potentialRow: some View {
        if let pva = report.potentialVsActual {
            let expected = pva.expectedKwh.formatted(.number.precision(.fractionLength(1)))
            let actual = pva.actualKwh.formatted(.number.precision(.fractionLength(1)))
            let prefix = report.source == .manual ? "A healthy system like yours should make" : "Expected"
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Potential vs actual", value: "\(actual) / \(expected) kWh")
                Text("\(prefix) \(expected) kWh on a clear day like \(pva.day); yours made \(actual) kWh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            LabeledContent("Potential vs actual", value: "Waiting for clear days")
        }
    }

    private var shadingRow: some View {
        let value: String
        if !report.shading.isShaded {
            value = "None detected"
        } else {
            let seasons = Array(Set(report.shading.entries.map(\.season.capitalizedName))).sorted()
            let joined = seasons.joined(separator: ", ")
            value = report.shading.hasGrowth ? "\(joined) (grown)" : joined
        }
        return LabeledContent("Shading", value: value)
    }

    private var dirtRow: some View {
        let value: String
        if report.dirtLevel.isActive, let loss = report.dirtLevel.currentLossPercent {
            value = "About \(loss.formatted(.number.precision(.fractionLength(1))))% loss"
        } else if let recovered = report.dirtLevel.lastRecoveredDay {
            value = "Clean · recovered \(recovered)"
        } else {
            value = "Clean"
        }
        return LabeledContent("Dirt level", value: value)
    }

    @ViewBuilder private var changeRow: some View {
        let change = report.changeOverTime
        if change.hasEnoughHistoryForTrend {
            if let rate = change.agingPercentPerYear {
                let sign = rate >= 0 ? "+" : ""
                let formatted = "\(sign)\(rate.formatted(.number.precision(.fractionLength(1))))% / yr"
                LabeledContent("Change over time", value: formatted)
            } else {
                LabeledContent("Change over time", value: "\(change.years.count) years loaded")
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Change over time", value: "Needs more history")
                Text("Load older history to track panel aging and shading growth over years.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let onLoadMoreHistory {
                    Button("Load More History", action: onLoadMoreHistory)
                        .font(.subheadline.weight(.medium))
                }
            }
        }
    }

    private var findingsSection: some View {
        Section {
            if report.visibleFindings.isEmpty {
                Label("No issues found", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(report.visibleFindings) { finding in
                    SolarHealthFindingRow(finding: finding)
                }
            }
        } header: {
            Text("Findings")
        } footer: {
            if usedWeather {
                SolarForecastAttributionView(
                    attribution: "Weather history by Open-Meteo.",
                    url: OpenMeteoProvider.sourceDescriptor.attributionURL)
            }
        }
    }
}

private struct SolarHealthFindingRow: View {
    let finding: SolarHealthFinding

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(finding.title)
                .font(.subheadline.weight(.semibold))
            Text(finding.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("\(finding.confidence.label) · \(finding.clearDays) clear days")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
