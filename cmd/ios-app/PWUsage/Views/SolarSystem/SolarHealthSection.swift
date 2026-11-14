import SwiftUI

/// Combined Panel Health section: score, stats, compact findings row, ratio trend, and history analyzed.
struct SolarHealthSection: View {
    let report: SolarHealthReport
    let isLoading: Bool
    var onShowFindings: () -> Void = {}
    var onEditLayout: () -> Void = {}
    var deepHistory: SiteDeepHistoryModel?
    var healthResult: SolarHealthResult?

    var body: some View {
        Section {
            scoreBlock
            potentialRow
            shadingRow
            dirtRow
            changeRow
            findingsRow
            if !report.changeOverTime.months.isEmpty || !report.dailyRatios.isEmpty {
                NavigationLink("Capacity & Ratio Trend") {
                    SolarHealthTrendView(report: report)
                }
            }
            historyAnalyzedRow
        } header: {
            sectionHeader
        }
    }

    private var sectionHeader: some View {
        HStack {
            Text("Panel Health")
            if isLoading {
                Spacer()
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var scoreBlock: some View {
        if let score = report.healthScore {
            healthScoreRows(score)
        } else if report.source == .manual {
            Text(SolarHealthScorePresentation.waitingForClearDays)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            manualPromptRow
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

    private var changeRow: some View {
        let change = report.changeOverTime
        let value: String
        if change.hasEnoughHistoryForTrend {
            if let rate = change.agingPercentPerYear {
                let sign = rate >= 0 ? "+" : ""
                value = "\(sign)\(rate.formatted(.number.precision(.fractionLength(1))))% / yr"
            } else {
                value = "\(change.years.count) years loaded"
            }
        } else {
            value = "Needs more history"
        }
        return LabeledContent("Change over time", value: value)
    }

    @ViewBuilder
    private var findingsRow: some View {
        let findings = report.visibleFindings
        if findings.isEmpty {
            LabeledContent("Findings") {
                Label("No issues found", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
        } else {
            Button(action: onShowFindings) {
                findingsSummaryLabel(findings: findings)
            }
            .foregroundStyle(.primary)
        }
    }

    private func findingsSummaryLabel(findings: [SolarHealthFinding]) -> some View {
        let categories = SolarHealthFindingCategory.unique(in: findings)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Findings")
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(findings.count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.onEmphasis)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.emphasis, in: Capsule())
                    .fixedSize()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 6) {
                ForEach(categories, id: \.self) { category in
                    Text(category.label)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.emphasis)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.emphasis.opacity(0.14), in: Capsule())
                        .fixedSize()
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var historyAnalyzedRow: some View {
        SolarHistoryAnalyzedRow(
            report: report,
            healthResult: healthResult,
            deepHistory: deepHistory)
    }
}

/// Compact summary of what went into the health analysis (history span, clear days, weather),
/// with inline deep-history controls only while more history can be or is being loaded.
private struct SolarHistoryAnalyzedRow: View {
    let report: SolarHealthReport
    let healthResult: SolarHealthResult?
    let deepHistory: SiteDeepHistoryModel?

    @Environment(\.reconnectTesla) private var reconnectTesla

    var body: some View {
        let presentation = deepHistory.map { SiteDeepHistoryPresentation(status: $0.status) }
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("History analyzed", value: headlineValue)
            if !detailParts.isEmpty {
                Text(detailParts.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let deepHistory, let presentation, presentation.action != nil || deepHistory.status.isLoading {
                deepHistoryActionView(model: deepHistory, presentation: presentation)
            }
        }
    }

    private var headlineValue: String {
        let resultDays = healthResult?.years.reduce(0) { $0 + $1.clearDays }
        let clearCount = resultDays ?? report.dailyRatios.count
        return "\(clearCount) clear \(clearCount == 1 ? "day" : "days")"
    }

    private var detailParts: [String] {
        var parts: [String] = []
        if let back = deepHistory?.status.loadedBack {
            parts.append("Back to \(SiteDeepHistoryPresentation.format(back))")
        } else if !report.changeOverTime.years.isEmpty {
            let count = report.changeOverTime.years.count
            parts.append("\(count) \(count == 1 ? "year" : "years")")
        }
        if let days = deepHistory?.status.daysLoaded, days > 0 {
            parts.append("\(days) days loaded")
        }
        if let weather = healthResult?.weather, weather.hasPrecipitation {
            let precipDays = weather.rainDays.union(weather.snowDays).count
            parts.append("\(precipDays) rain/snow \(precipDays == 1 ? "day" : "days")")
        }
        return parts
    }

    @ViewBuilder
    private func deepHistoryActionView(
        model: SiteDeepHistoryModel,
        presentation: SiteDeepHistoryPresentation
    ) -> some View {
        if model.status.isLoading {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(presentation.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        if let action = presentation.action {
            actionButton(action, model: model)
                .font(.subheadline.weight(.medium))
        }
    }

    @ViewBuilder
    private func actionButton(_ action: SiteDeepHistoryPresentation.Action, model: SiteDeepHistoryModel) -> some View {
        switch action {
        case .load:
            Button("Load More History") { model.start() }
        case .continueLoading:
            Button("Continue Loading") { model.start() }
        case .stop:
            Button("Stop") { Task { await model.stop() } }
        case .reconnectTesla:
            if let reconnectTesla {
                Button("Reconnect Tesla") { Task { await reconnectTesla.perform() } }
            }
        }
    }
}
