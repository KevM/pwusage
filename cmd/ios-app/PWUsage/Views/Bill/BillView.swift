import SwiftUI

struct BillView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    var isSelected = true
    var onOpenSmartShift: (() -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @State private var projections = BillOutlookProjectionCache()
    @State private var amountBottom: CGFloat = 0
    @State private var visibleTop: CGFloat = 0
    @State private var sheet: BillSheet?
    private let scrollSpace = "billScrollContent"

    private var state: DashboardEndpointState<MobileBillResponse> { coordinator.bill }
    private var response: MobileBillResponse? { coordinator.bill.response }
    private var timeZone: String { response?.site.timezone ?? "UTC" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if state.isUnavailable {
                    AvailabilityBanner(
                        message: "The estimate could not be refreshed. "
                            + "Any amount shown keeps its original calculation time.",
                        symbol: "clock.badge.exclamationmark"
                    )
                }
                if let response {
                    TimelineView(.periodic(from: .now, by: 60)) { _ in
                        outlook(response, now: .now)
                    }
                } else if state.isUnavailable {
                    EmptyCard(
                        symbol: "doc.text.magnifyingglass", title: "Bill estimate unavailable",
                        message: "The server could not provide a current estimate. "
                            + "Try again when your connection is available."
                    )
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading bill estimate")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22)
                    .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .padding(20)
            .coordinateSpace(name: scrollSpace)
            .frame(maxWidth: SectionTheme.maxContentWidth)
            .frame(maxWidth: .infinity)
        }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top
        } action: { _, top in
            visibleTop = top
        }
        .refreshable {
            await coordinator.billOutlookRefreshed()
        }
        .task(id: "\(site.id)-\(isSelected)") {
            if isSelected { await coordinator.billOutlookAppeared() } else {
                coordinator.solarSurfaceDisappeared(.bill)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && isSelected {
                Task { await coordinator.billOutlookAppeared(markVisible: false) }
            }
        }
        .onDisappear { coordinator.solarSurfaceDisappeared(.bill) }
        .background { SectionTheme.bill.screenBackground }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case let .savings(move, currency):
                BillSavingsSheet(move: move, currency: currency, onOpenSmartShift: onOpenSmartShift)
            case let .details(details):
                BillEstimateDetailsSheet(details: details)
            }
        }
        .navigationTitle("Current Bill")
        .inlineNavigationTitle()
        .toolbar {
            if let bill = response?.currentBill, amountBottom > 0, visibleTop >= amountBottom {
                if #available(iOS 26, *) {
                    ToolbarItem(placement: .topBarTrailing) {
                        toolbarAmount(bill)
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        toolbarAmount(bill)
                    }
                }
            }
        }
    }

    private func toolbarAmount(_ bill: MobileBillResponse.Bill) -> some View {
        let amount = DashboardPresentation.currency(bill.estimatedCost, code: bill.currency)
        return Text(amount)
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .accessibilityLabel("Current bill estimate, \(amount)")
    }

    @ViewBuilder private func outlook(_ response: MobileBillResponse, now: Date) -> some View {
        let context = coordinator.loadPlanningContext ?? coordinator.householdPattern
        let forecast = coordinator.pricingForecastIntervals(at: now)
        let isPending = !state.isUnavailable && coordinator.billProjectionIsPending(at: now)
        let result: BillOutlook.ProjectionResult = {
            guard let history = response.outlook, let context, context.timeZone == timeZone,
                  !state.isUnavailable, !isPending else { return .empty }
            return projections.result(history: history, context: context, forecast: forecast, now: now,
                                      cycleEnd: response.currentBill.cycleEnd)
        }()
        let projected = result.points
        let bill = response.currentBill
        let daysLeft = BillOutlookPresentation.daysLeft(now: now, end: bill.cycleEnd, timeZone: timeZone)
        estimateHeader(response, result: result, daysLeft: daysLeft, isPending: isPending)
        if let move = BillOutlookPresentation.savingsMove(projected: projected,
                                                          remaining: response.outlook?.tariffTimeline ?? [],
                                                          cycleEnd: bill.cycleEnd, daysLeft: daysLeft) {
            BillSavingsRow(move: move, currency: bill.currency) {
                sheet = .savings(move, currency: bill.currency)
            }
        }
        if let history = response.outlook, !history.points.isEmpty {
            BillOutlookChart(history: history, projected: projected, cycleStart: bill.cycleStart,
                             cycleEnd: bill.cycleEnd, now: now, timeZone: timeZone,
                             currency: bill.currency,
                             totals: bill.periods)
            if projected.isEmpty && history.complete && !isPending {
                Text("Forecast unavailable. Showing recorded energy with its original calculation time.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else {
            BillRatePeriodTotals(periods: bill.periods, currency: bill.currency)
        }
        billMetadata(response, usesSolar: result.usesSolar)
    }

    private func estimateHeader(_ response: MobileBillResponse, result: BillOutlook.ProjectionResult,
                                daysLeft: Int?, isPending: Bool) -> some View {
        let bill = response.currentBill
        let end = result.points.last
        let projection: BillEstimateHeader.Projection = end.map {
            .amount($0.estimatedCost, label: BillOutlookPresentation.projectionLabel(
                projectedEnd: $0.date, cycleEnd: bill.cycleEnd, timeZone: timeZone))
        } ?? (isPending ? .pending : .none)
        let fraction: Double? = {
            if isPending { return 0 }
            guard let end, let soFar = bill.estimatedCost else { return nil }
            return BillOutlookPresentation.fillFraction(soFar: soFar, projected: end.estimatedCost)
        }()
        let basis = end.map { _ in
            BillOutlookPresentation.projectionBasis(usesSolar: result.usesSolar, usesHistory: result.usesHistory)
        }
        return BillEstimateHeader(
            soFar: bill.estimatedCost, currency: bill.currency, projection: projection, fillFraction: fraction,
            daysLeft: daysLeft.map(BillOutlookPresentation.daysLeftLabel), isSelected: isSelected,
            onInfo: {
                sheet = .details(.init(basis: basis, periods: bill.periods, currency: bill.currency))
            },
            scrollSpace: scrollSpace,
            onAmountBottomChange: { amountBottom = $0 }
        )
    }

    private func billMetadata(_ response: MobileBillResponse, usesSolar: Bool) -> some View {
        let cycleStart = DashboardPresentation.date(response.currentBill.cycleStart,
                                                    timeZoneIdentifier: timeZone, dateStyle: .short)
        let cycleEnd = DashboardPresentation.date(response.currentBill.cycleEnd,
                                                  timeZoneIdentifier: timeZone, dateStyle: .short)
        return VStack(alignment: .leading, spacing: 3) {
            Text("Estimates cover energy charges and credits.")
            Text("\(site.name) · Billing cycle \(cycleStart)–\(cycleEnd)")
            if let energyDataThrough = response.sources.energyDataThrough {
                let through = DashboardPresentation.date(energyDataThrough, timeZoneIdentifier: timeZone,
                                                         dateStyle: .short, timeStyle: .short)
                Text("Energy through \(through)")
            }
            if let source = coordinator.attributionDescriptor(usesSolar: usesSolar) {
                SolarForecastAttributionView(descriptor: source)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private enum BillSheet: Identifiable {
    case savings(BillSavingsMove, currency: String)
    case details(BillEstimateDetails)

    var id: String {
        switch self {
        case .savings: "savings"
        case .details: "details"
        }
    }
}
