import SwiftUI

/// One stretch of dates the change affects: the plan before and after, then usage and production
/// rates aligned by season and time, so plans with differently named or timed periods compare fairly.
struct RatePlanReviewIntervalSection: View {
    let interval: TariffReviewAffectedInterval
    let currency: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Section {
            if let keeps = RatePlanReviewPresentation.keepsPlanLine(interval) {
                Text(keeps)
            } else {
                planRow("Before", plan: interval.before)
                planRow("After", plan: interval.after)
            }
            if let note = RatePlanReviewPresentation.fallbackNote(interval) {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let note = RatePlanReviewPresentation.restorationNote(interval.restoration) {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if RatePlanReviewPresentation.comparesRates(interval) {
                if !interval.hasRateChanges, !interval.hasPeriodNameChanges, interval.before != nil {
                    Text("Rates and time periods are the same.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(interval.seasons.enumerated()), id: \.offset) { _, season in
                    RatePlanReviewSeasonView(season: season, currency: currency)
                }
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Text(RatePlanReviewPresentation.rangeLabel(from: interval.effectiveFrom, to: interval.effectiveTo))
                Text(RatePlanReviewPresentation.intervalHeadline(interval))
                    .textCase(nil)
            }
        }
    }

    private func planRow(_ title: String, plan: TariffReviewPlanSnapshot?) -> some View {
        let isStacked = dynamicTypeSize.isAccessibilitySize
        let layout = isStacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
        return layout {
            Text(title)
            if !isStacked { Spacer(minLength: 8) }
            VStack(alignment: isStacked ? .leading : .trailing, spacing: 2) {
                Text(plan?.name ?? "No plan")
                    .foregroundStyle(.secondary)
                if let plan {
                    Text(RatePlanSourcePresentation.sourceLabel(plan.source))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(isStacked ? .leading : .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct RatePlanReviewSeasonView: View {
    let season: TariffAlignedSeasonComparison
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(RatePlanReviewPresentation.seasonLabel(season))
                .font(.subheadline.weight(.semibold))
            dayGroup("Weekdays", rows: season.weekdayRows)
            dayGroup("Weekends", rows: season.weekendRows)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func dayGroup(_ title: String, rows: [TariffAlignedTimeRow]) -> some View {
        if !rows.isEmpty {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                RatePlanReviewRateRow(row: row, currency: currency)
            }
        }
    }
}

private struct RatePlanReviewRateRow: View {
    let row: TariffAlignedTimeRow
    let currency: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(RatePlanReviewPresentation.timeLabel(row))
                .font(.caption.monospacedDigit())
            rateLine("Usage", keyPath: \.buyRate, changed: row.buyRateChanged)
            rateLine("Production", keyPath: \.sellRate, changed: row.sellRateChanged)
        }
        .accessibilityElement(children: .combine)
    }

    private func rateLine(
        _ label: String,
        keyPath: KeyPath<TariffComparisonSlotRate, Double>,
        changed: Bool
    ) -> some View {
        let text = RatePlanReviewPresentation.rateChange(
            before: row.before, after: row.after, rate: keyPath, currency: currency
        )
        let isStacked = dynamicTypeSize.isAccessibilitySize
        let layout = isStacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 6))
        return layout {
            Text(label)
                .foregroundStyle(.secondary)
            if !isStacked { Spacer(minLength: 4) }
            Text(text)
                .fontWeight(changed ? .semibold : .regular)
                .foregroundStyle(changed ? Color.emphasis : Color.primary)
                .multilineTextAlignment(isStacked ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption.monospacedDigit())
        .accessibilityLabel(changed ? "\(label) changes: \(text)" : "\(label): \(text)")
    }
}
