import PWUsageCore
import SwiftUI

private enum RatePlanChangeRoute: Hashable {
    case review
}

/// Dates first, then a public plan in effect on those dates (or the saved Tesla plan), then the
/// review. Entering rates by hand hands off to the rate plan editor, which reviews the same way.
struct RatePlanChangeFlow: View {
    @State private var model: RatePlanChangeModel
    @State private var path: [RatePlanChangeRoute] = []
    let utilityName: String?
    /// Nil hides the manual option (restoration has none).
    let onEnterManually: (() -> Void)?
    let onApplied: (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void
    @Environment(\.dismiss) private var dismiss

    init(
        model: RatePlanChangeModel,
        utilityName: String?,
        onEnterManually: (() -> Void)? = nil,
        onApplied: @escaping (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void
    ) {
        _model = State(initialValue: model)
        self.utilityName = utilityName
        self.onEnterManually = onEnterManually
        self.onApplied = onApplied
    }

    /// The Change Plan or Restore flow for a site's Rate Plans screen.
    static func make(
        kind: RatePlanChangeModel.Kind,
        timeline: SiteTariffsTimelineResponse?,
        actions: TariffTimelineActions,
        onEnterManually: @escaping () -> Void,
        onApplied: @escaping (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void
    ) -> Self {
        let model = RatePlanChangeModel(
            kind: kind,
            timeZone: timeline.flatMap { TimeZone(identifier: $0.timezone) } ?? .current,
            selection: actions.selection,
            loadPlans: actions.publicPlans
        )
        let manual: (() -> Void)? = if case .publicPlan = kind { onEnterManually } else { nil }
        return Self(
            model: model,
            utilityName: timeline?.estimates?.utilityName,
            onEnterManually: manual,
            onApplied: onApplied
        )
    }

    var body: some View {
        @Bindable var bindableModel = model
        NavigationStack(path: $path) {
            Form {
                introSection
                RatePlanDateChoiceSection(
                    start: $bindableModel.start,
                    end: $bindableModel.end,
                    timeZone: model.timeZone
                )
                if let problem = model.datesProblem, model.start != nil || model.end != nil {
                    Section { Text(problem).foregroundStyle(.red) }
                }
                choiceSection
                if let onEnterManually {
                    Section {
                        Button("Enter Rates Myself", action: onEnterManually)
                    } footer: {
                        Text("Copy the prices and time periods from your utility bill.")
                    }
                }
            }
            .navigationTitle(title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .navigationDestination(for: RatePlanChangeRoute.self) { _ in
                    if let review = model.review {
                        RatePlanReviewView(model: review) { response, request in
                            onApplied(response, request)
                            dismiss()
                        }
                    }
                }
        }
    }

    private var title: String {
        switch model.kind {
        case .publicPlan: "Change Rate Plan"
        case .restoreTesla: "Restore Tesla Plan"
        }
    }

    @ViewBuilder
    private var introSection: some View {
        switch model.kind {
        case .publicPlan:
            Section {
                Text("Choose when the plan applies, then pick it. You’ll review every change before it’s saved.")
                    .foregroundStyle(.secondary)
            }
        case .restoreTesla(_, let planName):
            Section {
                Text("Puts back the Tesla plan that \(planName) replaced, for the dates you choose. "
                    + "Your Powerwall isn’t changed.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var choiceSection: some View {
        switch model.kind {
        case .publicPlan:
            RatePlanChangePublicPlansSection(model: model, utilityName: utilityName) { label in
                if model.startReview(publicPlanLabel: label) != nil { path = [.review] }
            }
        case .restoreTesla:
            Section {
                Button(RatePlanReviewPresentation.restoreActionTitle) {
                    if model.startReview() != nil { path = [.review] }
                }
                .disabled(model.dates == nil)
            } footer: {
                if let problem = model.datesProblem {
                    Text(problem)
                }
            }
        }
    }
}

private struct RatePlanChangePublicPlansSection: View {
    let model: RatePlanChangeModel
    let utilityName: String?
    let onChoose: (String) -> Void

    var body: some View {
        Section {
            rows
        } header: {
            Text(utilityName.map { "\($0) Plans" } ?? "Public Utility Plans")
        } footer: {
            Text("Estimated from public utility rates in the OpenEI Utility Rate Database.")
        }
        .task(id: model.dates?.from) {
            if model.dates != nil, model.plans == .idle { await model.loadPublicPlans() }
        }
    }

    @ViewBuilder
    private var rows: some View {
        switch model.plans {
        case .idle:
            Text(model.dates == nil ? "Choose the dates first." : "Loading plans…")
                .foregroundStyle(.secondary)
        case .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .unavailable(let message):
            Text(message).foregroundStyle(.secondary)
            Button("Try Again") { Task { await model.loadPublicPlans() } }
        case .loaded(let response):
            if response.plans.isEmpty {
                Text("No residential plans are listed for these dates.")
                    .foregroundStyle(.secondary)
            }
            ForEach(response.plans) { plan in
                Button {
                    onChoose(plan.label)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plan.name).foregroundStyle(.primary)
                        Text(Self.revisionLabel(plan))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private static func revisionLabel(_ plan: UtilityPlanDTO) -> String {
        "Published rates since \(RatePlanTimelineFormatting.displayDate(plan.revisionStart ?? plan.startDate))"
    }
}
