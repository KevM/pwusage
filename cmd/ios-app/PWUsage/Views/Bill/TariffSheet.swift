import SwiftUI

private enum TariffSheetModal: Identifiable, Equatable {
    case effectiveDates(TariffPeriodDTO)
    case editor(RatePlanEditorMode)

    var id: String {
        switch self {
        case .effectiveDates(let period): "dates-\(period.periodId)"
        case .editor(let mode): "editor-\(mode.id)"
        }
    }
}

struct TariffSheet: View {
    let site: MobileSite
    let actions: TariffTimelineActions

    @Environment(\.scenePhase) private var scenePhase
    @State private var timeline: SiteTariffsTimelineResponse?
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var isLoading = false
    @State private var isSyncing = false
    @State private var syncNotice: String?
    @State private var isRetryingReattribution = false
    @State private var activeModal: TariffSheetModal?
    @State private var pendingDeletion: TariffPeriodDTO?
    @State private var minuteTick = Date()

    var body: some View {
        contentView
            .navigationTitle("Rate Plans")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .toolbar { toolbarContent }
            .task(id: site.id) { await initialLoad() }
            .task(id: pollingKey) { await pollReattributionWhileActive() }
            .task(id: scenePhase) { await refreshAndTickMinute() }
            .sheet(item: $activeModal) { modalView(for: $0) }
            .confirmationDialog(
                "Delete Rate Plan?",
                isPresented: isDeletingBinding,
                titleVisibility: .visible,
                presenting: pendingDeletion,
                actions: deleteDialogActions,
                message: deleteDialogMessage
            )
    }

    @ViewBuilder
    private var contentView: some View {
        if let timeline {
            timelineScrollView(timeline)
        } else if let loadError {
            EmptyStateScreen(
                symbol: "exclamationmark.triangle",
                title: "Couldn't load rate plans",
                message: loadError,
                actionTitle: "Try Again"
            ) {
                Task { await performLoad(showSpinner: true) }
            }
        } else {
            ProgressView("Loading rate plans...")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(SectionTheme.groupedBackground)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                syncFromTesla()
            } label: {
                if isSyncing {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Sync from Tesla", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .disabled(isSyncing || isLoading)
        }
    }

    private func timelineScrollView(_ data: SiteTariffsTimelineResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                headerBannerSection(data)
                timelinePeriodsSection(data)
                addPlanButton
            }
            .padding(16)
            .frame(maxWidth: SectionTheme.maxContentWidth)
            .frame(maxWidth: .infinity)
        }
        .background { SectionTheme.bill.screenBackground }
        .refreshable { await performLoad(showSpinner: false) }
    }

    @ViewBuilder
    private func headerBannerSection(_ data: SiteTariffsTimelineResponse) -> some View {
        if let actionError {
            errorBanner(actionError)
        }
        if let reattribution = data.reattribution {
            ReattributionBannerView(
                status: reattribution,
                isRetrying: isRetryingReattribution,
                onRetry: retryReattribution
            )
        }
        if let syncNotice {
            Label(syncNotice, systemImage: "checkmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
        if data.teslaSync.differsFromActiveManual {
            teslaDivergenceBanner(data.teslaSync)
        }
        ActiveRatePlanCardView(timeline: data, now: minuteTick)
    }

    @ViewBuilder
    private func timelinePeriodsSection(_ data: SiteTariffsTimelineResponse) -> some View {
        let sortedPeriods = data.periods.sorted { $0.effectiveFrom > $1.effectiveFrom }
        if sortedPeriods.isEmpty {
            CardContainer(padding: 18, cornerRadius: 16, spacing: 8) {
                Text("No rate plans yet")
                    .font(.headline)
                Text("Sync your plan from Tesla or create a custom Rate Plan.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("Rate Plan History")
                .font(.headline)
                .padding(.top, 4)
            ForEach(Array(sortedPeriods.enumerated()), id: \.element.periodId) { index, period in
                if index > 0,
                   let gapText = RatePlanTimelineFormatting.gapDescription(
                       newer: sortedPeriods[index - 1],
                       older: period
                   ) {
                    timelineGapRow(gapText)
                }
                TariffPeriodCardView(
                    period: period,
                    currency: data.currency,
                    onEditPlan: { activeModal = .editor(.edit(period)) },
                    onCopyPlan: { activeModal = .editor(.copy(period)) },
                    onEditDates: { activeModal = .effectiveDates(period) },
                    onDelete: { pendingDeletion = period }
                )
            }
        }
    }

    private func timelineGapRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(.secondary.opacity(0.4))
        )
    }

    private func teslaDivergenceBanner(_ sync: TeslaSyncDTO) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.badge.clock")
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                let copy = TeslaDivergenceCopy(sync: sync)
                Text(copy.title)
                    .font(.subheadline.weight(.medium))
                Text(copy.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Sync") { syncFromTesla() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isSyncing)
        }
        .padding(14)
        .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
            Text(message).font(.caption).foregroundStyle(.red)
            Spacer()
        }
        .padding(12)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var addPlanButton: some View {
        Button {
            activeModal = .editor(.add)
        } label: {
            Label("Add Rate Plan", systemImage: "plus.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .emphasisProminentButton()
        .controlSize(.large)
        .padding(.top, 4)
    }

    @ViewBuilder
    private func modalView(for modal: TariffSheetModal) -> some View {
        switch modal {
        case .effectiveDates(let period):
            EffectiveDatesSheet(period: period) { periodID, patch in
                let updated = try await actions.updatePeriod(periodID, patch)
                timeline = updated
            }
        case .editor(let mode):
            RatePlanEditorFlow(
                mode: mode,
                timeZone: timeline.flatMap { TimeZone(identifier: $0.timezone) } ?? .current,
                currency: timeline?.currency ?? "USD",
                onCreate: { writeRequest in
                    timeline = try await actions.createPeriod(writeRequest)
                },
                onUpdate: { periodID, patch in
                    timeline = try await actions.updatePeriod(periodID, patch)
                }
            )
        }
    }

    private var isDeletingBinding: Binding<Bool> {
        Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        )
    }

    @ViewBuilder
    private func deleteDialogActions(for period: TariffPeriodDTO) -> some View {
        Button("Delete Rate Plan", role: .destructive) {
            pendingDeletion = nil
            deletePeriod(period)
        }
        Button("Cancel", role: .cancel) {
            pendingDeletion = nil
        }
    }

    private func deleteDialogMessage(for period: TariffPeriodDTO) -> some View {
        Text(
            "Removing \"\(period.name)\" restores any prior Tesla or custom plan covering its dates "
                + "and recalculates historical costs."
        )
    }

    private var isPresentingEditor: Bool { activeModal != nil }

    private var shouldPollReattribution: Bool {
        guard let status = timeline?.reattribution?.status else { return false }
        return status == .pending || status == .running
    }

    private var pollingKey: String {
        let token = timeline?.reattribution?.updatedAt ?? "none"
        return "\(site.id)-\(isPresentingEditor)-\(shouldPollReattribution)-\(token)"
    }

    private func initialLoad() async {
        await performLoad(showSpinner: timeline == nil)
    }

    private func performLoad(showSpinner: Bool) async {
        if showSpinner { isLoading = true }
        defer { if showSpinner { isLoading = false } }
        do {
            let loaded = try await actions.load()
            timeline = loaded
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            if timeline == nil {
                loadError = error.localizedDescription
            } else {
                actionError = error.localizedDescription
            }
        }
    }

    private func pollReattributionWhileActive() async {
        guard !isPresentingEditor, shouldPollReattribution else { return }
        while !Task.isCancelled && !isPresentingEditor && shouldPollReattribution {
            do {
                try await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, !isPresentingEditor else { return }
                timeline = try await actions.load()
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func refreshAndTickMinute() async {
        guard scenePhase == .active else { return }
        minuteTick = Date()
        while !Task.isCancelled && scenePhase == .active {
            let seconds = Calendar.current.component(.second, from: Date())
            let delay = max(1, 60 - seconds)
            do {
                try await Task.sleep(for: .seconds(delay))
                minuteTick = Date()
            } catch {
                return
            }
        }
    }

    private func syncFromTesla() {
        actionError = nil
        syncNotice = nil
        isSyncing = true
        let previousTeslaPlan = timeline?.teslaSync.latestTariffId
        Task {
            do {
                let refreshed = try await actions.refreshFromTesla()
                timeline = refreshed
                syncNotice = TeslaDivergenceCopy.syncNotice(previousTeslaPlan: previousTeslaPlan, refreshed: refreshed)
                isSyncing = false
            } catch {
                isSyncing = false
                actionError = error.localizedDescription
            }
        }
    }

    private func retryReattribution() {
        actionError = nil
        isRetryingReattribution = true
        Task {
            do {
                timeline = try await actions.retryReattribution()
                isRetryingReattribution = false
            } catch {
                isRetryingReattribution = false
                actionError = error.localizedDescription
            }
        }
    }

    private func deletePeriod(_ period: TariffPeriodDTO) {
        actionError = nil
        Task {
            do {
                timeline = try await actions.deletePeriod(period.periodId)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}
