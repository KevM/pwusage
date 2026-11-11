import SwiftUI

#if canImport(UIKit) && !os(tvOS)
    import UIKit
#endif

struct RatePlanSeasonsEditorView: View {
    @Bindable var state: RatePlanEditorState
    let isWizard: Bool
    let onFinish: () -> Void

    @State private var lastSnappedMonth: Int?
    private static let rowHeight: CGFloat = 28

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerView
                    HStack(alignment: .top, spacing: 14) {
                        seasonListColumn
                        MonthPartitionSlider(
                            seasons: state.draft.seasons,
                            rowHeight: Self.rowHeight,
                            onMoveBoundary: moveBoundaryWithHaptic
                        )
                        .frame(width: 96)
                    }
                    addSeasonButton
                }
                .padding(16)
            }
            footerButton
        }
        .background(SectionTheme.groupedBackground)
        .navigationTitle("Select Seasons")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private var headerView: some View {
        Text("Seasons define when schedules or prices change during the year. Drag handles to adjust months.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private var seasonListColumn: some View {
        VStack(spacing: 10) {
            ForEach(Array(state.draft.seasons.enumerated()), id: \.element.id) { index, season in
                seasonCard(index: index, season: season)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func seasonCard(index: Int, season: SeasonDraft) -> some View {
        CardContainer(padding: 12, cornerRadius: 12, spacing: 8) {
            HStack {
                Circle().fill(Self.seasonColor(at: index)).frame(width: 9, height: 9)
                TextField("Season name", text: seasonNameBinding(at: index))
                    .font(.subheadline.weight(.semibold))
                if state.draft.seasons.count > 1 {
                    Button {
                        state.draft.removeSeason(at: index)
                    } label: {
                        Image(systemName: "trash").font(.caption).foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(season.name)")
                }
            }
            Text(RatePlanTimelineFormatting.seasonMonthLabel(fromMonth: season.fromMonth, toMonth: season.toMonth))
                .font(.caption)
                .foregroundStyle(.secondary)
            if state.draft.seasons.count > 1 {
                boundaryStepperRow(index: index, season: season)
            }
        }
    }

    private func boundaryStepperRow(index: Int, season: SeasonDraft) -> some View {
        let nextIndex = (index + 1) % state.draft.seasons.count
        let nextMonth = state.draft.seasons[nextIndex].fromMonth
        return HStack(spacing: 8) {
            Text("End month").font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Button("-1m") { state.draft.moveSeasonBoundary(afterIndex: index, toStartMonth: nextMonth - 1) }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            Button("+1m") { state.draft.moveSeasonBoundary(afterIndex: index, toStartMonth: nextMonth + 1) }
                .buttonStyle(.bordered)
                .controlSize(.mini)
        }
    }

    @ViewBuilder
    private var addSeasonButton: some View {
        if state.draft.seasons.count < 6 {
            Button {
                state.draft.addSeason()
            } label: {
                Label("Add Season", systemImage: "plus.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
    }

    private var footerButton: some View {
        Button(action: onFinish) {
            Text(isWizard ? "Next: Set Rate Schedule" : "Done")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .padding(16)
        .background(SectionTheme.secondaryGroupedBackground)
    }

    private func seasonNameBinding(at index: Int) -> Binding<String> {
        Binding(
            get: { state.draft.seasons.indices.contains(index) ? state.draft.seasons[index].name : "" },
            set: { newValue in
                if state.draft.seasons.indices.contains(index) {
                    state.draft.seasons[index].name = newValue
                }
            }
        )
    }

    private func moveBoundaryWithHaptic(afterIndex index: Int, toStartMonth month: Int) {
        let normalized = ((month - 1) % 12 + 12) % 12 + 1
        state.draft.moveSeasonBoundary(afterIndex: index, toStartMonth: normalized)
        if lastSnappedMonth != normalized {
            lastSnappedMonth = normalized
            triggerLightHaptic()
        }
    }

    private func triggerLightHaptic() {
        #if canImport(UIKit) && !os(tvOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    static func seasonColor(at index: Int) -> Color {
        let palette: [Color] = [.blue, .orange, .teal, .purple, .pink, .green]
        return palette[index % palette.count]
    }
}

private struct MonthPartitionSlider: View {
    let seasons: [SeasonDraft]
    let rowHeight: CGFloat
    let onMoveBoundary: (Int, Int) -> Void

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                ForEach(1 ... 12, id: \.self) { month in
                    monthRow(month: month)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            if seasons.count > 1 {
                ForEach(Array(seasons.indices), id: \.self) { index in
                    boundaryHandle(afterIndex: index)
                }
            }
        }
        .frame(height: rowHeight * 12)
    }

    private func monthRow(month: Int) -> some View {
        let ownerIndex = ownerSeasonIndex(forMonth: month)
        return ZStack {
            RatePlanSeasonsEditorView.seasonColor(at: ownerIndex).opacity(0.24)
            Text(RatePlanTimelineFormatting.monthAbbreviation(month))
                .font(.caption.weight(.medium))
        }
        .frame(height: rowHeight)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder
    private func boundaryHandle(afterIndex index: Int) -> some View {
        let nextIndex = (index + 1) % seasons.count
        let startMonth = seasons[nextIndex].fromMonth
        let yOffset = CGFloat(startMonth - 1) * rowHeight - 10
        Capsule()
            .fill(Color.primary.opacity(0.85))
            .frame(width: 56, height: 18)
            .overlay {
                Image(systemName: "line.3.horizontal")
                    .font(.caption2)
                    .foregroundStyle(Color.white)
            }
            .offset(y: max(-4, min(rowHeight * 12 - 14, yOffset)))
            .gesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { value in
                        let monthIndex = Int((value.location.y / rowHeight).rounded()) + 1
                        let clamped = max(1, min(12, monthIndex))
                        onMoveBoundary(index, clamped)
                    }
            )
            .accessibilityLabel("Adjust season boundary near \(RatePlanTimelineFormatting.fullMonthName(startMonth))")
    }

    private func ownerSeasonIndex(forMonth month: Int) -> Int {
        for (index, season) in seasons.enumerated() {
            if season.fromMonth <= season.toMonth {
                if month >= season.fromMonth && month <= season.toMonth { return index }
            } else if month >= season.fromMonth || month <= season.toMonth {
                return index
            }
        }
        return 0
    }
}
