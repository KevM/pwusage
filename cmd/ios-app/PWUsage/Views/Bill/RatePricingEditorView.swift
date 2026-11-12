import SwiftUI

struct RatePricingEditorView: View {
    @Bindable var state: RatePlanEditorState
    let seasonIndex: Int
    let isWizard: Bool
    let onFinish: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    seasonSummaryStrip
                    tierCardsSection
                    exportHelperNote
                }
                .padding(16)
            }
            footerButton
        }
        .background(SectionTheme.groupedBackground)
        .navigationTitle("Set Prices")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder
    private var seasonSummaryStrip: some View {
        if let season = currentSeason {
            CardContainer(padding: 14, cornerRadius: 14, spacing: 8) {
                HStack {
                    Text(season.name).font(.headline)
                    Spacer()
                    Text(
                        RatePlanTimelineFormatting.seasonMonthLabel(
                            fromMonth: season.fromMonth,
                            toMonth: season.toMonth
                        )
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                stripPreview(label: "Weekdays", windows: season.weekdayWindows.compactMap { $0.toInput() })
                let weekendInputs = (season.sameScheduleAsWeekdays ? season.weekdayWindows : season.weekendWindows)
                    .compactMap { $0.toInput() }
                stripPreview(label: "Weekends", windows: weekendInputs)
            }
        }
    }

    private func stripPreview(label: String, windows: [TimePeriodWindowInput]) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption2).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
            DayStripBarView(windows: windows)
        }
    }

    @ViewBuilder
    private var tierCardsSection: some View {
        if let season = currentSeason {
            ForEach(activePeriodTypes(in: season), id: \.self) { periodName in
                RateInputCard(
                    periodName: periodName,
                    currency: state.currency,
                    buyBinding: buyBinding(for: periodName, in: season),
                    sellBinding: sellBinding(for: periodName, in: season)
                )
            }
        }
    }

    private var exportHelperNote: some View {
        Text(
            "Enter Buy and Sell prices per kWh with up to 5 decimal places. "
                + "Sell rates are used to estimate export credits and bill savings."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private var footerButton: some View {
        Button(action: onFinish) {
            Text(isWizard ? "Review Rate Plan" : "Done")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .emphasisProminentButton()
        .controlSize(.large)
        .disabled(currentSeason?.validateRates() != nil)
        .padding(16)
        .background(SectionTheme.secondaryGroupedBackground)
    }

    private var currentSeason: SeasonDraft? {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return nil }
        return state.draft.seasons[seasonIndex]
    }

    private func activePeriodTypes(in season: SeasonDraft) -> [TariffPeriodName] {
        let combined = season.weekdayWindows + (season.sameScheduleAsWeekdays ? [] : season.weekendWindows)
        let present = Set(combined.map(\.touName))
        return TariffPeriodName.allCases.filter { present.contains($0) }
    }

    private func buyBinding(for periodName: TariffPeriodName, in season: SeasonDraft) -> Binding<String> {
        let initial = sampleWindow(for: periodName, in: season)?.buyRateText ?? "0.00"
        return Binding(
            get: { sampleWindow(for: periodName, in: currentSeason ?? season)?.buyRateText ?? initial },
            set: { state.updateRate(seasonIndex: seasonIndex, touName: periodName, buyRateText: $0) }
        )
    }

    private func sellBinding(for periodName: TariffPeriodName, in season: SeasonDraft) -> Binding<String> {
        let initial = sampleWindow(for: periodName, in: season)?.sellRateText ?? "0.00"
        return Binding(
            get: { sampleWindow(for: periodName, in: currentSeason ?? season)?.sellRateText ?? initial },
            set: { state.updateRate(seasonIndex: seasonIndex, touName: periodName, sellRateText: $0) }
        )
    }

    private func sampleWindow(for periodName: TariffPeriodName, in season: SeasonDraft) -> DayPeriodDraft? {
        (season.weekdayWindows + season.weekendWindows).first { $0.touName == periodName }
    }
}

private struct RateInputCard: View {
    let periodName: TariffPeriodName
    let currency: String
    @Binding var buyBinding: String
    @Binding var sellBinding: String

    var body: some View {
        CardContainer(padding: 14, cornerRadius: 14, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(periodName.tintColor).frame(width: 9, height: 9)
                Text(periodName.displayName).font(.headline)
                Spacer()
                Text(currency).font(.caption).foregroundStyle(.secondary)
            }
            rateFieldRow(title: "Buy", text: $buyBinding)
            rateFieldRow(title: "Sell", text: $sellBinding)
        }
    }

    private func rateFieldRow(title: String, text: Binding<String>) -> some View {
        let validation = RateFormatting.parseRate(text.wrappedValue)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.subheadline).frame(width: 48, alignment: .leading)
                TextField("0.00", text: text)
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
                    .multilineTextAlignment(.trailing)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospacedDigit())
            }
            if case .failure(let error) = validation {
                Text(error.localizedDescription)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
    }
}
