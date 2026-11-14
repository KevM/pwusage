import SwiftUI

/// Health stats, capacity score, ratio trend link and plain-language findings for Solar System.
struct SolarHealthSection: View {
    let report: SolarHealthReport
    let isLoading: Bool
    var usedWeather = false
    var onEditLayout: () -> Void = {}
    var deepHistory: SiteDeepHistoryModel?

    var body: some View {
        healthCardSection
        statsSection
        findingsSection
    }

    private var healthCardSection: some View {
        Section {
            if let score = report.healthScore {
                healthScoreRows(score)
            } else if report.source == .manual {
                Text(SolarHealthScorePresentation.waitingForClearDays)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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
        let presentation = SolarHealthScorePresentation(score: score)
        healthHeadlineRow(presentation)
        LabeledContent(presentation.efficiencyLabel, value: presentation.efficiencyValue)
        if let note = presentation.olderPanelsNote {
            captionNote(note)
        }
        if let note = presentation.restartNote {
            captionNote(note)
        }
        ForEach(presentation.directionRows, id: \.azimuth) { direction in
            LabeledContent(
                SolarSystemDetailsRows.direction(direction.azimuth),
                value: direction.value)
        }
        if let prompt = presentation.panelCheckPrompt {
            panelCheckRow(prompt)
        }
    }

    private func healthHeadlineRow(_ presentation: SolarHealthScorePresentation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Health") {
                Text("\(presentation.headline) \(presentation.band)")
                    .fontWeight(.semibold)
                    .foregroundStyle(presentation.isEmphasized ? Color.emphasis : Color.primary)
            }
            if let detail = presentation.headlineDetail {
                captionNote(detail)
            }
        }
    }

    private func captionNote(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func panelCheckRow(_ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(prompt)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Check Panel Details", action: onEditLayout)
                .font(.subheadline.weight(.medium))
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
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Potential vs actual", value: "\(actual) / \(expected) kWh")
                Text(SolarHealthScorePresentation.potentialCaption(pva))
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
                deepHistoryFeedback
            }
        }
    }

    @ViewBuilder private var deepHistoryFeedback: some View {
        if let deepHistory {
            let deep = SiteDeepHistoryPresentation(status: deepHistory.status)
            if deepHistory.status.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(deep.statusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button("Stop") { Task { await deepHistory.stop() } }
                    .font(.subheadline.weight(.medium))
            } else if deep.action == .load || deep.action == .continueLoading {
                Text("Load older history to track panel aging and shading growth over years.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button(deep.action == .continueLoading ? "Continue Loading" : "Load More History") {
                    deepHistory.start()
                }
                .font(.subheadline.weight(.medium))
            } else {
                Text(deep.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("Load older history to track panel aging and shading growth over years.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
