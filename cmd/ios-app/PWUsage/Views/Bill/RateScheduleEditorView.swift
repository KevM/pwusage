import SwiftUI

#if canImport(UIKit) && !os(tvOS)
    import UIKit
#endif

struct RateScheduleEditorView: View {
    @Bindable var state: RatePlanEditorState
    let seasonIndex: Int
    let isWizard: Bool
    let onFinish: () -> Void

    @State private var selectedGroup: ScheduleDayGroup
    @State private var lastSnappedSlot: Int?

    init(
        state: RatePlanEditorState,
        seasonIndex: Int,
        initialDayGroup: ScheduleDayGroup,
        isWizard: Bool,
        onFinish: @escaping () -> Void
    ) {
        self.state = state
        self.seasonIndex = seasonIndex
        self.isWizard = isWizard
        self.onFinish = onFinish
        _selectedGroup = State(initialValue: initialDayGroup)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    seasonHeader
                    dayGroupPicker
                    if selectedGroup == .weekends {
                        sameAsWeekdayToggle
                    }
                    editorColumns
                }
                .padding(16)
            }
            footerButton
        }
        .background(SectionTheme.groupedBackground)
        .navigationTitle("Rate Schedule")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder
    private var seasonHeader: some View {
        if let season = currentSeason {
            Text(
                "\(season.name) · "
                    + RatePlanTimelineFormatting.seasonMonthLabel(
                        fromMonth: season.fromMonth,
                        toMonth: season.toMonth
                    )
            )
            .font(.headline)
        }
    }

    private var dayGroupPicker: some View {
        Picker("Day Group", selection: $selectedGroup) {
            ForEach(ScheduleDayGroup.allCases, id: \.self) { group in
                Text(group.label).tag(group)
            }
        }
        .pickerStyle(.segmented)
    }

    private var sameAsWeekdayToggle: some View {
        Toggle(
            "Same schedule as weekdays",
            isOn: Binding(
                get: { currentSeason?.sameScheduleAsWeekdays ?? true },
                set: { state.setSameScheduleAsWeekdays($0, seasonIndex: seasonIndex) }
            )
        )
        .padding(12)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var editorColumns: some View {
        if let season = currentSeason {
            let isWeekday = selectedGroup == .weekdays
            let isMirroredWeekend = !isWeekday && season.sameScheduleAsWeekdays
            let windows = isWeekday || season.sameScheduleAsWeekdays
                ? season.weekdayWindows
                : season.weekendWindows
            HStack(alignment: .top, spacing: 14) {
                SchedulePeriodListColumn(
                    windows: windows,
                    isEditable: !isMirroredWeekend,
                    onChangeType: { index, name in updatePeriodType(at: index, to: name, isWeekday: isWeekday) },
                    onStepBoundary: { index, slot in
                        moveBoundary(afterIndex: index, toSlot: slot, isWeekday: isWeekday)
                    },
                    onRemove: { index in removePeriod(at: index, isWeekday: isWeekday) },
                    onAdd: { addPeriod(isWeekday: isWeekday) }
                )
                TimelineTrackSlider(
                    windows: windows,
                    isInteractive: !isMirroredWeekend,
                    onMoveBoundary: { index, slot in
                        moveBoundary(afterIndex: index, toSlot: slot, isWeekday: isWeekday)
                    }
                )
                .frame(width: 72)
            }
        }
    }

    private var footerButton: some View {
        Button(action: onFinish) {
            Text(isWizard ? "Next: Set Prices" : "Done")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .padding(16)
        .background(SectionTheme.secondaryGroupedBackground)
    }

    private var currentSeason: SeasonDraft? {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return nil }
        return state.draft.seasons[seasonIndex]
    }

    private func updatePeriodType(at index: Int, to periodName: TariffPeriodName, isWeekday: Bool) {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return }
        if isWeekday {
            guard state.draft.seasons[seasonIndex].weekdayWindows.indices.contains(index) else { return }
            state.draft.seasons[seasonIndex].weekdayWindows[index].touName = periodName
            if state.draft.seasons[seasonIndex].sameScheduleAsWeekdays {
                state.draft.seasons[seasonIndex].weekendWindows = state.draft.seasons[seasonIndex].weekdayWindows
            }
        } else {
            guard state.draft.seasons[seasonIndex].weekendWindows.indices.contains(index) else { return }
            state.draft.seasons[seasonIndex].sameScheduleAsWeekdays = false
            state.draft.seasons[seasonIndex].weekendWindows[index].touName = periodName
        }
    }

    private func moveBoundary(afterIndex index: Int, toSlot slot: Int, isWeekday: Bool) {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return }
        state.draft.seasons[seasonIndex].movePeriodBoundary(afterIndex: index, toSlot: slot, isWeekday: isWeekday)
        if lastSnappedSlot != slot {
            lastSnappedSlot = slot
            triggerLightHaptic()
        }
    }

    private func addPeriod(isWeekday: Bool) {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return }
        state.draft.seasons[seasonIndex].addTimePeriod(isWeekday: isWeekday)
    }

    private func removePeriod(at index: Int, isWeekday: Bool) {
        guard state.draft.seasons.indices.contains(seasonIndex) else { return }
        state.draft.seasons[seasonIndex].removeTimePeriod(at: index, isWeekday: isWeekday)
    }

    private func triggerLightHaptic() {
        #if canImport(UIKit) && !os(tvOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}

private struct SchedulePeriodListColumn: View {
    let windows: [DayPeriodDraft]
    let isEditable: Bool
    let onChangeType: (Int, TariffPeriodName) -> Void
    let onStepBoundary: (Int, Int) -> Void
    let onRemove: (Int) -> Void
    let onAdd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !isEditable {
                Text("Weekends mirror your weekday schedule. Toggle above to customize.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(windows.enumerated()), id: \.element.id) { index, window in
                periodRowCard(index: index, window: window)
            }
            if isEditable && windows.contains(where: { $0.slotDuration >= 2 }) {
                Button(action: onAdd) {
                    Label("Add Rate Period", systemImage: "plus.circle")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func periodRowCard(index: Int, window: DayPeriodDraft) -> some View {
        CardContainer(padding: 12, cornerRadius: 12, spacing: 8) {
            HStack {
                Circle().fill(window.touName.tintColor).frame(width: 9, height: 9)
                if isEditable {
                    Picker("Rate Period", selection: periodTypeBinding(index: index, current: window.touName)) {
                        ForEach(TariffPeriodName.allCases, id: \.self) { name in
                            Text(name.displayName).tag(name)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                } else {
                    Text(window.touName.displayName).font(.subheadline.weight(.semibold))
                }
                Spacer()
                if isEditable && windows.count > 1 {
                    Button { onRemove(index) } label: {
                        Image(systemName: "trash").font(.caption).foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(window.touName.displayName) period")
                }
            }
            Text(window.formattedTimeRange)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if isEditable && windows.count > 1 {
                HStack(spacing: 8) {
                    Text("End time").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button("-30m") { onStepBoundary(index, window.endSlot - 1) }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                    Button("+30m") { onStepBoundary(index, window.endSlot + 1) }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                }
            }
        }
    }

    private func periodTypeBinding(index: Int, current: TariffPeriodName) -> Binding<TariffPeriodName> {
        Binding(
            get: { current },
            set: { onChangeType(index, $0) }
        )
    }
}

private struct TimelineTrackSlider: View {
    let windows: [DayPeriodDraft]
    let isInteractive: Bool
    let onMoveBoundary: (Int, Int) -> Void

    private static let trackHeight: CGFloat = 336

    var body: some View {
        VStack(spacing: 4) {
            markerRow(symbol: "moon.fill", label: "12 AM")
            ZStack(alignment: .top) {
                VStack(spacing: 0) {
                    ForEach(0 ..< 48, id: \.self) { slot in
                        Rectangle().fill(slotPeriod(slot)?.tintColor ?? .secondary)
                            .frame(height: Self.trackHeight / 48)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Image(systemName: "sun.max.fill")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.85))
                    .offset(y: Self.trackHeight / 2 - 6)
                if isInteractive && windows.count > 1 {
                    ForEach(Array(windows.indices), id: \.self) { index in
                        trackHandle(afterIndex: index)
                    }
                }
            }
            .frame(height: Self.trackHeight)
            markerRow(symbol: "moon.fill", label: "12 AM")
        }
    }

    private func markerRow(symbol: String, label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.caption2).foregroundStyle(.secondary)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func trackHandle(afterIndex index: Int) -> some View {
        let boundarySlot = windows[index].endSlot == 48 ? 0 : windows[index].endSlot
        let yPosition = CGFloat(boundarySlot) / 48.0 * Self.trackHeight - 10
        Capsule()
            .fill(Color.primary.opacity(0.88))
            .frame(width: 48, height: 18)
            .overlay {
                Image(systemName: "line.3.horizontal").font(.caption2).foregroundStyle(.white)
            }
            .offset(y: max(-4, min(Self.trackHeight - 14, yPosition)))
            .gesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { value in
                        let ratio = max(0, min(1, value.location.y / Self.trackHeight))
                        let slot = Int((ratio * 48.0).rounded())
                        let clamped = max(1, min(47, slot))
                        onMoveBoundary(index, clamped)
                    }
            )
            .accessibilityLabel("Adjust time near \(RatePlanTimelineFormatting.slotTimeLabel(boundarySlot))")
    }

    private func slotPeriod(_ slot: Int) -> TariffPeriodName? {
        for window in windows {
            if window.isAllDay { return window.touName }
            if window.startSlot < window.endSlot {
                if slot >= window.startSlot && slot < window.endSlot { return window.touName }
            } else if slot >= window.startSlot || slot < window.endSlot {
                return window.touName
            }
        }
        return nil
    }
}
