import SwiftUI

/// The screen for the flow's current step. Each step keeps its own pending choice, so the view is
/// rebuilt (new `id`) whenever the step changes.
struct RatePlanHistoryStepView: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    let teslaPlanName: String?

    var body: some View {
        content.id(String(describing: flow.step))
    }

    @ViewBuilder private var content: some View {
        switch flow.step {
        case .currentKind, .kind:
            RatePlanKindStep(flow: flow, model: model)
        case .currentPlan, .plan:
            RatePlanPlanStep(flow: flow, model: model)
        case .peakHours:
            RatePlanHoursStep(flow: flow, model: model)
        case .sinceStart:
            RatePlanSinceStartStep(flow: flow, model: model)
        case .switchMonth:
            RatePlanSwitchMonthStep(flow: flow, model: model)
        case .review:
            RatePlanHistoryReviewView(
                flow: flow,
                model: model,
                teslaRow: RatePlanHistoryPresentation.teslaRow(history: flow.history, teslaPlanName: teslaPlanName)
            )
        }
    }
}

// MARK: - Kind

private struct RatePlanKindStep: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    @State private var selection: RatePlanKind?
    @State private var showsHelp = false

    init(flow: RatePlanHistoryFlow, model: RatePlanHistoryModel) {
        self.flow = flow
        self.model = model
        let kinds = RatePlanHistoryPresentation.kinds(in: flow.plans(for: flow.step))
        let tesla = flow.preselectedKind.flatMap { kinds.contains($0) ? $0 : nil }
        _selection = State(initialValue: tesla ?? (kinds.count == 1 ? kinds.first : nil))
    }

    private var plans: [RatePlanHistoryPlanDTO] {
        flow.plans(for: flow.step)
    }

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            HistoryChoiceCard {
                ForEach(RatePlanHistoryPresentation.kinds(in: plans), id: \.self) { kind in
                    HistoryChoiceRow(
                        title: RatePlanHistoryPresentation.kindTitle(kind),
                        detail: RatePlanHistoryPresentation.kindDetail(kind, in: plans),
                        pill: kind == flow.preselectedKind ? RatePlanHistoryPresentation.kindMatchesTeslaPill : nil,
                        isSelected: selection == kind
                    ) { selection = kind }
                }
            }
            HistoryNotSureButton { showsHelp = true }
        } footer: {
            HistoryContinueButton(isEnabled: selection != nil) {
                guard let selection else { return }
                model.update { $0.chooseKind(selection) }
            }
        }
        .sheet(isPresented: $showsHelp) {
            RatePlanKindHelpSheet(
                utilityName: flow.history.utilityName,
                plans: plans,
                hasTeslaPlan: flow.hasTeslaPlan
            ) { model.update { $0.stillNotSure() } }
        }
    }
}

// MARK: - Plan

private struct RatePlanPlanStep: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    @State private var selection: String?

    init(flow: RatePlanHistoryFlow, model: RatePlanHistoryModel) {
        self.flow = flow
        self.model = model
        let plans = flow.plans(for: flow.step)
        let preferred = plans.first(where: \.closest) ?? plans.first(where: \.isDefault) ?? plans.first
        _selection = State(initialValue: preferred?.id)
    }

    private var plans: [RatePlanHistoryPlanDTO] {
        flow.plans(for: flow.step)
    }

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            HistoryChoiceCard {
                ForEach(Array(plans.enumerated()), id: \.element.id) { index, plan in
                    if index > 0 { Divider().padding(.leading, 42) }
                    HistoryChoiceRow(
                        title: RatePlanHistoryPresentation.planRowTitle(plan, among: plans),
                        detail: RatePlanHistoryPresentation.priceRow(plan),
                        pill: RatePlanHistoryPresentation.planPill(plan),
                        isSelected: selection == plan.id
                    ) { selection = plan.id }
                }
            }
            HistoryNotSureButton { model.update { $0.stillNotSure() } }
        } footer: {
            HistoryContinueButton(isEnabled: selection != nil) {
                guard let plan = plans.first(where: { $0.id == selection }) else { return }
                model.update { $0.choosePlan(plan) }
            }
        }
    }
}

// MARK: - Peak hours

private struct RatePlanHoursStep: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    @State private var selection: String?

    init(flow: RatePlanHistoryFlow, model: RatePlanHistoryModel) {
        self.flow = flow
        self.model = model
        _selection = State(initialValue: flow.preselectedWindowLabel ?? flow.pickedPlan?.peakWindows.first?.label)
    }

    private var windows: [RatePlanPeakWindowDTO] {
        flow.pickedPlan?.peakWindows ?? []
    }

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            HistoryChoiceCard {
                ForEach(Array(windows.enumerated()), id: \.element.id) { index, window in
                    if index > 0 { Divider().padding(.leading, 42) }
                    HistoryChoiceRow(
                        title: RatePlanHistoryPresentation.windowRow(window),
                        pill: window.label == flow.pickedPlan?.closestWindow
                            ? RatePlanHistoryPresentation.hoursMatchTeslaPill : nil,
                        isSelected: selection == window.label
                    ) { selection = window.label }
                }
            }
            Text(RatePlanHistoryPresentation.hoursCaption)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
            HistoryNotSureButton { model.update { $0.stillNotSure() } }
        } footer: {
            HistoryContinueButton(isEnabled: selection != nil) {
                guard let window = windows.first(where: { $0.label == selection }) else { return }
                model.update { $0.choosePeakWindow(window) }
            }
        }
    }
}

// MARK: - Since the start

private struct RatePlanSinceStartStep: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            EmptyView()
        } footer: {
            Button { model.update { $0.answerSinceStart(true) } } label: {
                Text(RatePlanHistoryPresentation.yesTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .emphasisProminentButton()
            .controlSize(.large)
            Button { model.update { $0.answerSinceStart(false) } } label: {
                Text(RatePlanHistoryPresentation.noTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.emphasis)
            .controlSize(.large)
            HistoryNotSureButton { model.update { $0.stillNotSure() } }
        }
    }
}

// MARK: - Switch month

private struct RatePlanSwitchMonthStep: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    @State private var month: String

    init(flow: RatePlanHistoryFlow, model: RatePlanHistoryModel) {
        self.flow = flow
        self.model = model
        _month = State(initialValue: flow.defaultSwitchMonth() ?? "")
    }

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            Picker(RatePlanHistoryPresentation.question(flow), selection: $month) {
                ForEach(flow.switchMonths(), id: \.self) { month in
                    Text(RatePlanHistoryPresentation.switchMonthLabel(month)).tag(month)
                }
            }
            .pickerStyle(.wheel)
            .labelsHidden()
            .background(
                SectionTheme.secondaryGroupedBackground,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
        } footer: {
            HistoryContinueButton(isEnabled: !month.isEmpty) {
                model.update { $0.chooseSwitchMonth(month) }
            }
        }
    }
}
