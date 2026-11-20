import SwiftUI

/// Tesla's plan beside the plan PWUsage would send, then one confirmed send.
struct TeslaSyncSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.reconnectTesla) private var reconnectTesla
    @State private var model: TeslaSyncModel
    let currency: String

    init(
        actions: TeslaSyncActions,
        currency: String,
        onTimeline: @escaping @MainActor (SiteTariffsTimelineResponse) -> Void
    ) {
        _model = State(initialValue: TeslaSyncModel(actions: actions, onTimeline: onTimeline))
        self.currency = currency
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(TeslaSyncCopy.sendButton)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(TeslaSyncCopy.cancelButton) { dismiss() }
                            .disabled(isSending)
                    }
                }
                .interactiveDismissDisabled(isSending)
                .task {
                    if case .loading = model.phase { await model.load() }
                }
        }
    }

    private var isSending: Bool {
        if case .sending = model.phase { return true }
        return false
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView("Checking Tesla…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .review(let preview):
            reviewForm(preview, isSending: false)
        case .sending(let preview):
            reviewForm(preview, isSending: true)
        case .unavailable(let unavailable):
            unavailableForm(unavailable)
        case .finished(let result):
            finishedForm(result)
        case .failed(let message):
            EmptyStateScreen(
                symbol: "exclamationmark.triangle",
                title: "Couldn't sync to Tesla",
                message: message,
                actionTitle: "Try Again"
            ) {
                Task { await model.load() }
            }
        }
    }

    private func reviewForm(_ preview: TeslaSyncPreviewDTO, isSending: Bool) -> some View {
        Form {
            if let notice = model.notice {
                Section { Text(notice) }
            }
            Section("Tesla now") {
                TeslaSyncPlanRows(name: preview.current.name, seasons: preview.current.seasons, currency: currency)
            }
            Section {
                TeslaSyncPlanRows(
                    name: preview.proposed.name,
                    seasons: preview.proposed.seasons,
                    currency: currency,
                    detail: RatePlanSourcePresentation.sourceLabel(preview.proposed.source)
                )
            } header: {
                Text("PWUsage will send")
            }
            TeslaSyncAdjustmentsSection(adjustments: preview.adjustments, currency: currency)
            if preview.estimated {
                Section { Text(TeslaSyncCopy.publicPlans) }
            }
            if preview.problems.isEmpty {
                sendSection(isSending: isSending)
            } else {
                Section {
                    ForEach(Array(preview.problems.enumerated()), id: \.offset) { _, problem in
                        Text(problem.message).foregroundStyle(.red)
                    }
                } header: {
                    Text("Fix these before syncing")
                }
            }
        }
        .disabled(isSending)
    }

    private func sendSection(isSending: Bool) -> some View {
        Section {
            Button {
                Task { await model.confirm() }
            } label: {
                HStack {
                    Text(TeslaSyncCopy.sendButton)
                        .fontWeight(.semibold)
                    if isSending {
                        Spacer()
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .emphasisProminentButton()
            .disabled(isSending || !model.canConfirm)
        } footer: {
            Text(TeslaSyncCopy.effect)
        }
    }

    private func unavailableForm(_ unavailable: TeslaSyncUnavailability) -> some View {
        Form {
            Section {
                Text(unavailable.message)
            }
            if unavailable.reason == "needs_reauth" || unavailable.reason == "not_allowed" {
                reconnectSection
            }
        }
    }

    private func finishedForm(_ result: TeslaSyncResultDTO) -> some View {
        let isSent = result.outcome == "confirmed" || result.outcome == "unconfirmed"
        return Form {
            Section {
                Label(
                    TeslaSyncCopy.resultMessage(result.outcome, message: result.message),
                    systemImage: isSent ? "checkmark.circle.fill" : "exclamationmark.circle"
                )
            }
            if result.outcome == "needs_reauth" || result.outcome == "not_allowed" {
                reconnectSection
            }
            Section {
                Button(TeslaSyncCopy.doneButton) { dismiss() }
                    .emphasisProminentButton()
            }
        }
    }

    /// Reuses the app's Tesla sign-in; the sheet closes first so the sign-in can present.
    @ViewBuilder
    private var reconnectSection: some View {
        if let reconnectTesla {
            Section {
                Button(TeslaSyncCopy.reconnectButton) {
                    dismiss()
                    Task { await reconnectTesla.perform() }
                }
            }
        }
    }
}

/// The Tesla-side changes a sync would make, one line each.
private struct TeslaSyncAdjustmentsSection: View {
    let adjustments: [TeslaSyncAdjustmentDTO]
    let currency: String

    var body: some View {
        if !adjustments.isEmpty {
            Section("Stored differently") {
                ForEach(Array(adjustments.enumerated()), id: \.offset) { _, adjustment in
                    Text(TeslaSyncCopy.adjustmentLine(adjustment, currency: currency))
                        .font(.subheadline)
                }
            }
        }
    }
}
