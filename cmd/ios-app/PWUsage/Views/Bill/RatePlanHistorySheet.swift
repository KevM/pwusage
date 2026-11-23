import PWUsageCore
import SwiftUI

/// The rate plan history guide: one question per screen, walking back from the current plan, then a
/// review. Opens from the Home accessory and from Rate Plans.
struct RatePlanHistorySheet: View {
    @State private var model: RatePlanHistoryModel
    let teslaPlanName: String?
    let currency: String
    @Environment(\.dismiss) private var dismiss

    init(model: RatePlanHistoryModel, teslaPlanName: String?, currency: String) {
        _model = State(initialValue: model)
        self.teslaPlanName = teslaPlanName
        self.currency = currency
    }

    init(
        teslaPlanName: String?,
        currency: String,
        referencePeriods: [TariffPeriodDTO],
        load: @escaping () async throws -> RatePlanHistoryDTO,
        save: @escaping ([RatePlanHistoryPeriod]) async throws -> Void
    ) {
        self.init(
            model: RatePlanHistoryModel(referencePeriods: referencePeriods, loadHistory: load, saveHistory: save),
            teslaPlanName: teslaPlanName,
            currency: currency
        )
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar { toolbarContent }
        }
        .interactiveDismissDisabled(model.isSaving)
        .task { await model.load() }
        .onChange(of: model.isDone) { _, isDone in
            if isDone { dismiss() }
        }
    }

    private var title: String {
        guard case .ready(let flow) = model.state else { return RatePlanHistoryPresentation.flowTitle }
        return RatePlanHistoryPresentation.navigationTitle(flow)
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { SectionTheme.bill.screenBackground }
        case .failed(let message):
            failedView(message)
        case .ready(let flow):
            RatePlanHistoryStepView(flow: flow, model: model, teslaPlanName: teslaPlanName, currency: currency)
        }
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: 14) {
            Text(message)
                .multilineTextAlignment(.center)
            Button(RatePlanHistoryPresentation.retryTitle) {
                Task { await model.reload() }
            }
            .emphasisProminentButton()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { SectionTheme.bill.screenBackground }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            if case .ready(let flow) = model.state, flow.step != .currentKind {
                Button { model.update { $0.back() } } label: {
                    Label("Back", systemImage: "chevron.backward")
                }
                .disabled(model.isSaving)
            } else {
                Button("Cancel") { dismiss() }
            }
        }
    }
}
