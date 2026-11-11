import SwiftUI

extension TariffPeriodName {
    var tintColor: Color {
        switch self {
        case .onPeak: Color(red: 0.90, green: 0.30, blue: 0.28)
        case .partialPeak: Color(red: 0.94, green: 0.58, blue: 0.18)
        case .offPeak: Color(red: 0.45, green: 0.50, blue: 0.58)
        case .superOffPeak: Color(red: 0.16, green: 0.68, blue: 0.55)
        }
    }
}

struct DayStripBarView: View {
    let windows: [TimePeriodWindowInput]

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 0) {
                ForEach(0 ..< 48, id: \.self) { slot in
                    let periodName = period(forSlot: slot)
                    Rectangle()
                        .fill(periodName?.tintColor ?? Color.secondary.opacity(0.2))
                        .frame(width: max(1, proxy.size.width / 48))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }

    private func period(forSlot slot: Int) -> TariffPeriodName? {
        for window in windows {
            let start = window.fromHour * 2 + (window.fromMinute >= 30 ? 1 : 0)
            let end = window.toHour == 24 ? 48 : window.toHour * 2 + (window.toMinute >= 30 ? 1 : 0)
            if end > start {
                if slot >= start && slot < end { return window.touName }
            } else if start > end {
                if slot >= start || slot < end { return window.touName }
            }
        }
        return nil
    }
}

struct TariffPeriodCardView: View {
    let period: TariffPeriodDTO
    let currency: String
    let onEditPlan: () -> Void
    let onCopyPlan: () -> Void
    let onEditDates: () -> Void
    let onDelete: () -> Void

    var body: some View {
        CardContainer(padding: 15, cornerRadius: 16, spacing: 10) {
            headerRow
            metadataRow
            Divider()
            ForEach(Array(period.seasons.enumerated()), id: \.offset) { _, season in
                seasonSummary(season)
            }
        }
    }

    private var headerRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(period.name)
                .font(.headline)
                .lineLimit(2)
            Spacer(minLength: 8)
            if period.isCurrentToday {
                badge("Current", tint: .green)
            }
            badge(period.source == .manual ? "Custom" : "Tesla", tint: period.source == .manual ? .blue : .secondary)
            actionsMenu
        }
    }

    private var actionsMenu: some View {
        Menu {
            if period.source == .manual {
                Button("Edit Plan", systemImage: "slider.horizontal.3", action: onEditPlan)
                Button("Edit Dates", systemImage: "calendar", action: onEditDates)
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive, action: onDelete)
            } else {
                Button("Copy & Customize", systemImage: "doc.on.doc", action: onCopyPlan)
                Button("Edit Dates", systemImage: "calendar", action: onEditDates)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Actions for \(period.name)")
    }

    private var metadataRow: some View {
        Text(metadataLine)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var metadataLine: String {
        let range = RatePlanTimelineFormatting.displayRange(from: period.effectiveFrom, to: period.effectiveTo)
        guard let updated = period.updatedBy else { return range }
        if updated.isCurrentUser {
            return "\(range) · Edited by you"
        }
        if let email = updated.email, !email.isEmpty {
            return "\(range) · Edited by \(email)"
        }
        return range
    }

    private func badge(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(tint)
            .background(tint.opacity(0.14), in: Capsule())
    }

    private func seasonSummary(_ season: TariffSeasonInput) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(season.name).font(.subheadline.weight(.semibold))
                Spacer()
                Text(RatePlanTimelineFormatting.seasonMonthLabel(fromMonth: season.fromMonth, toMonth: season.toMonth))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            stripRow(label: "Weekdays", windows: season.weekdayPeriods)
            stripRow(label: "Weekends", windows: season.weekendPeriods)
            rateSummaryGrid(season: season)
        }
        .padding(.top, 2)
    }

    private func stripRow(label: String, windows: [TimePeriodWindowInput]) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 60, alignment: .leading)
            DayStripBarView(windows: windows)
        }
    }

    private func rateSummaryGrid(season: TariffSeasonInput) -> some View {
        let distinctRates = uniqueRates(from: season)
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(distinctRates.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 6) {
                    Circle().fill(item.touName.tintColor).frame(width: 7, height: 7)
                    Text(item.touName.displayName).font(.caption)
                    Spacer()
                    let buy = RateFormatting.formatRate(item.buyRate, currency: currency)
                    let sell = RateFormatting.formatRate(item.sellRate, currency: currency)
                    Text("Buy \(buy) · Sell \(sell)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func uniqueRates(from season: TariffSeasonInput) -> [TimePeriodWindowInput] {
        var seen: Set<TariffPeriodName> = []
        var result: [TimePeriodWindowInput] = []
        for window in season.weekdayPeriods + season.weekendPeriods where !seen.contains(window.touName) {
            seen.insert(window.touName)
            result.append(window)
        }
        return result
    }
}
