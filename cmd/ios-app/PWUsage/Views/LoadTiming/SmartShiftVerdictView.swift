import SwiftUI
import UIKit

struct SmartShiftVerdictView: View {
    let verdict: SmartShiftVerdict
    let timeZone: String
    var isSelected = true
    var onOpenSolarSettings: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selection: SmartShiftSelection
    @State private var landingCount = 0
    @State private var isPopping = false

    init(verdict: SmartShiftVerdict, timeZone: String, isSelected: Bool = true,
         onOpenSolarSettings: @escaping () -> Void = {}) {
        self.verdict = verdict
        self.timeZone = timeZone
        self.isSelected = isSelected
        self.onOpenSolarSettings = onOpenSolarSettings
        _selection = State(initialValue: SmartShiftSelection(choices: verdict.choices))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verdict.title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            Text(verdict.subtitle).font(.subheadline.weight(.semibold)).foregroundStyle(Color.emphasis)
            choiceTiles
            VStack(alignment: .leading, spacing: 2) {
                Text(verdict.chartTitle).font(.headline)
                Text(verdict.chartSubtitle).font(.caption).foregroundStyle(.secondary)
            }
            bankChart
            ForEach(Array(verdict.notes.enumerated()), id: \.offset) { _, note in noteView(note) }
        }
        .onChange(of: verdict) { _, updated in selection.reconcile(with: updated.choices) }
        .onChange(of: isSelected) { _, active in
            if active { selection = SmartShiftSelection(choices: verdict.choices) }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: landingCount)
    }

    @ViewBuilder private var choiceTiles: some View {
        if reduceMotion {
            SmartShiftChoiceTiles(choices: verdict.choices, selected: selection.selected,
                                  isPopping: isPopping, onSelect: select)
                .id(selection.selected).transition(.opacity)
        } else {
            SmartShiftChoiceTiles(choices: verdict.choices, selected: selection.selected,
                                  isPopping: isPopping, onSelect: select)
        }
    }

    @ViewBuilder private var bankChart: some View {
        if reduceMotion {
            chart.id(selection.selected).transition(.opacity)
        } else {
            chart
        }
    }

    private var chart: some View {
        SmartShiftBankChart(bars: verdict.rateBars, slot: verdict.slot, selection: selection.selected,
                            marks: selection.marks, isSlotHeld: selection.isReturning, isPopping: isPopping,
                            onTapSlot: returnToSuggested)
    }

    private func select(_ id: SmartShiftChoiceID) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : .smooth(duration: 0.6)) { selection.select(id) }
    }

    private func returnToSuggested() {
        if reduceMotion {
            withAnimation(.easeInOut(duration: 0.25)) {
                selection.beginReturn()
                selection.landReturn()
            }
            announceLanding()
            return
        }
        withAnimation(.timingCurve(0.6, 0.02, 0.8, 0.25, duration: 1.15)) {
            selection.beginReturn()
        } completion: {
            guard selection.isReturning else { return }
            withAnimation(.spring) { selection.landReturn(); landingCount += 1 }
            pop()
            announceLanding()
        }
    }

    private func pop() {
        withAnimation(.spring(duration: 0.18)) { isPopping = true } completion: {
            withAnimation(.spring(duration: 0.25)) { isPopping = false }
        }
    }

    private func announceLanding() {
        let choice = verdict.choices.first { $0.id == selection.selected }?.label ?? ""
        let totals = verdict.rateBars.map { "\($0.name), \($0.state(for: selection.selected).total)" }
            .joined(separator: ". ")
        UIAccessibility.post(notification: .announcement, argument: "\(choice). \(totals)")
    }

    @ViewBuilder
    private func noteView(_ note: SmartShiftVerdict.Note) -> some View {
        switch note {
        case .noForecast(let usesHistory):
            noteText(usesHistory ? SmartShiftPresentation.noForecastHistoryNote : SmartShiftPresentation.noForecastNote)
        case .automaticForecast(let message):
            VStack(alignment: .leading, spacing: 6) {
                noteText(message)
                Button("Solar Forecast Settings", systemImage: "sun.max", action: onOpenSolarSettings)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
            }
        case .forecastState(let message):
            noteText(message)
        case .unobservedBalance:
            noteText(SmartShiftPresentation.unobservedBalanceNote)
        }
    }

    private func noteText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: SectionTheme.maxProseWidth, alignment: .leading)
    }
}
