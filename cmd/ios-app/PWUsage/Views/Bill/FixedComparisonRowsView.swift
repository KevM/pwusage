import PWUsageCore
import SwiftUI

/// A rate plan's fixed comparison plan rows: name, flat rate, Estimated, and Change. The editor puts a
/// Change on every row; the guide offers one Change for the whole plan.
struct FixedComparisonRowsView: View {
    let rows: [FixedComparisonRow]
    let currency: String
    /// A Change on each row (editor); nil leaves rows without one.
    var onChangeRow: ((FixedComparisonRow) -> Void)?
    /// One Change for the whole group (guide).
    var onChangeAll: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(FixedComparisonPresentation.heading)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                rowView(row)
            }
            if let onChangeAll {
                changeButton(action: onChangeAll)
            }
            Text(FixedComparisonPresentation.footer)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rowView(_ row: FixedComparisonRow) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        return layout {
            VStack(alignment: .leading, spacing: 2) {
                if rows.count > 1 {
                    Text(FixedComparisonPresentation.range(row))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(FixedComparisonPresentation.title(row))
                    .font(.subheadline)
                    .foregroundStyle(row.reference == nil ? .secondary : .primary)
                if let detail = FixedComparisonPresentation.detail(row, currency: currency) {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
            if let onChangeRow {
                changeButton { onChangeRow(row) }
            }
        }
    }

    private func changeButton(action: @escaping () -> Void) -> some View {
        Button(FixedComparisonPresentation.changeTitle, action: action)
            .font(.subheadline)
            .buttonStyle(.borderless)
    }
}

#Preview {
    let window = TimePeriodWindowInput(
        touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.16, sellRate: 0
    )
    let season = TariffSeasonInput(
        name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window]
    )
    let reference = TariffPeriodDTO(
        periodId: 1, tariffId: 1, name: "Standard Residential", version: 1, source: .estimated,
        effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", isCurrentToday: false, updatedBy: nil,
        seasons: [season]
    )
    FixedComparisonRowsView(
        rows: [
            FixedComparisonRow(from: "2024-01-01", to: "2024-12-31", reference: reference),
            FixedComparisonRow(from: "2025-01-01", to: nil, reference: nil)
        ],
        currency: "USD",
        onChangeRow: { _ in }
    )
    .padding()
}
