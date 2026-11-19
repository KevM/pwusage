import SwiftUI

struct TariffSheet: View {
    let site: MobileSite
    let actions: TariffTimelineActions
    /// Opened from Bill's setup card: start on the add-plan form.
    var startsAddingPlan = false

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
    @State private var didOpenStartingAddForm = false
    private let historyOfferDismissals = RateEstimatesAccessoryDismissals.sharedHistoryOffer

    var body: some View {
        contentView
            .navigationTitle("Rate Plans")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .toolbar { toolbarContent }
            .task(id: site.id) { await initialLoad() }
            .task(id: pollingKey) { await pollWhileServerIsWorking() }
            .task(id: scenePhase) { await refreshAndTickMinute() }
            .onChange(of: timeline != nil, initial: true) { _, loaded in openStartingAddFormIfNeeded(loaded) }
            .sheet(item: $activeModal, onDismiss: reloadTimeline) { modalView(for: $0) }
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
                TariffSheetFooterButtons(
                    onAddPlan: { activeModal = .editor(.add) },
                    onAiHandoff: { activeModal = .aiHandoff }
                )
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
        RateEstimatesRatePlanSection(
            estimates: data.estimates,
            historyStart: historyOfferStart(data),
            onFindHistory: { activeModal = .rateHistory },
            onDismissHistory: { historyOfferDismissals.dismiss(siteID: site.id) },
            onAddRatePlan: { activeModal = .newPlan(for: data) },
            addRatePlanTitle: RateEstimatesPresentation.addRatePlanTitle(for: data),
            onChooseUtility: {
                activeModal = .estimates(RateEstimatesPresentation.utilityRowPrompt(data.estimates))
            },
            onChoosePlan: { activeModal = .estimates(.pickPlan) }
        )
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
            teslaDivergenceBanner(data.teslaSync, isSyncing: isSyncing, onSync: syncFromTesla)
        }
        ActiveRatePlanCardView(timeline: data, now: minuteTick, onChangePlan: data.supportsRatePlanSelection
            ? { activeModal = .changePlan(for: data) } : nil)
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
                    estimates: data.estimates,
                    onEditPlan: { activeModal = .editor(.edit(period)) },
                    onCopyPlan: { activeModal = .editor(.copy(period)) },
                    onEditDates: { activeModal = .effectiveDates(period) },
                    onDelete: { pendingDeletion = period },
                    onRestoreTesla: RatePlanSourcePresentation.canRestoreTesla(period, in: data)
                        ? { activeModal = .restore(period) } : nil
                )
            }
        }
    }

    @ViewBuilder
    private func modalView(for modal: TariffSheetModal) -> some View {
        switch modal {
        case .effectiveDates(let period):
            EffectiveDatesSheet(period: period) { periodID, patch in
                let updated = try await actions.updatePeriod(periodID, patch)
                timeline = updated
            }
        case .estimates(let prompt):
            RateEstimatesSetupSheet(prompt: prompt, utilityName: timeline?.estimates?.utilityName, actions: actions)
        case .rateHistory:
            rateHistorySheet
        case .changePlan, .restore:
            RatePlanChangeFlow.make(
                kind: modal.changeKind, timeline: timeline, actions: actions,
                onEnterManually: { activeModal = .editor(.add) }, onApplied: { timeline = $0.timeline }
            )
        case .aiHandoff:
            RatePlanAiHandoffSheet(actions: actions.aiHandoff) { timeline = $0 }
        case .editor(let mode):
            RatePlanEditorFlow(
                mode: mode,
                timeZone: timeline.flatMap { TimeZone(identifier: $0.timezone) } ?? .current,
                currency: timeline?.currency ?? "USD",
                takenNames: mode.takenNames(among: timeline?.periods ?? []),
                onCreate: { writeRequest in
                    timeline = try await actions.createPeriod(writeRequest)
                },
                onUpdate: { periodID, patch in
                    timeline = try await actions.updatePeriod(periodID, patch)
                },
                selection: timeline?.supportsRatePlanSelection == true ? actions.selection : nil,
                onApplied: { timeline = $0.timeline }
            )
        }
    }

    /// The history guide's first day while the offer shows: a guide the owner hasn't dismissed for this site.
    private func historyOfferStart(_ data: SiteTariffsTimelineResponse) -> String? {
        guard !historyOfferDismissals.isDismissed(siteID: site.id) else { return nil }
        return data.estimates?.historyGuide?.historyStart
    }

    private var rateHistorySheet: some View {
        RatePlanHistorySheet(
            teslaPlanName: timeline?.teslaSync.latestTariffName,
            load: { try await actions.loadRateHistory() },
            save: { timeline = try await actions.saveRateHistory($0) }
        )
    }

    private func openStartingAddFormIfNeeded(_ timelineLoaded: Bool) {
        guard RatePlanAddFormRule.shouldOpen(
            startsAddingPlan: startsAddingPlan,
            timelineLoaded: timelineLoaded,
            alreadyOpened: didOpenStartingAddForm
        ) else { return }
        didOpenStartingAddForm = true
        activeModal = .editor(.add)
    }

    /// Estimate and editor sheets can change the plans they show, so reload when one closes.
    private func reloadTimeline() {
        Task { await performLoad(showSpinner: false) }
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

    /// Re-pricing or a pending estimate job still running on the server; nil once both settle.
    private var pollInterval: Duration? {
        RatePlansPolling.interval(
            reattribution: timeline?.reattribution?.status,
            estimates: timeline?.estimates?.status
        )
    }

    private var pollingKey: String {
        let token = timeline?.reattribution?.updatedAt ?? "none"
        let estimates = timeline?.estimates?.status.rawValue ?? "none"
        return "\(site.id)-\(isPresentingEditor)-\(pollInterval != nil)-\(token)-\(estimates)"
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

    private func pollWhileServerIsWorking() async {
        while !Task.isCancelled && !isPresentingEditor, let interval = pollInterval {
            do {
                try await Task.sleep(for: interval)
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

private struct TariffSheetFooterButtons: View {
    let onAddPlan: () -> Void
    let onAiHandoff: () -> Void

    var body: some View {
        Button(action: onAddPlan) {
            Label("Add Rate Plan", systemImage: "plus.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .emphasisProminentButton()
        .controlSize(.large)
        .padding(.top, 4)

        Button(action: onAiHandoff) {
            Label("Check with Your AI Assistant", systemImage: "sparkles")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}
