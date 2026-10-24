import SwiftUI

/// The Home tab's content. It has no navigation chrome of its own: the host
/// supplies the stack (which shows `navigationTitle`), and the summary cards
/// switch tabs through `onOpenTab` rather than pushing duplicate pages.
struct DashboardView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    let onOpenTab: (AppTab) -> Void
    var onRefresh: (() async -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var availableWidth: Double = 0
    /// Re-checks the stale notice each minute; readings age without the view otherwise redrawing.
    @State private var clock = Date.now

    private var live: MobileLiveResponse? { coordinator.live.response }
    private var power: MobileLivePowerResponse? {
        coordinator.power.response ?? live.map(MobileLivePowerResponse.init(snapshot:))
    }
    private var bill: MobileBillResponse? { coordinator.bill.response }

    private var usesTwoColumns: Bool {
        DashboardPresentation.homeUsesTwoColumns(
            width: availableWidth,
            isRegularWidth: horizontalSizeClass == .regular,
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                staleNotice
                if usesTwoColumns {
                    Grid(alignment: .topLeading, horizontalSpacing: 22, verticalSpacing: 22) {
                        GridRow {
                            liveSection.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            todaySection.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        }
                        GridRow {
                            billNavigation.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            loadTimingNavigation.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        }
                    }
                    // Side-by-side cards share a top and bottom edge.
                    .environment(\.dashboardCardsFillHeight, true)
                } else {
                    liveSection
                    todaySection
                    billNavigation
                    loadTimingNavigation
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 28)
            .frame(maxWidth: usesTwoColumns ? 1100 : 760)
            .frame(maxWidth: .infinity)
        }
        .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { availableWidth = $0 }
        .refreshable {
            if let onRefresh { await onRefresh() }
            else { await coordinator.refreshAll(trigger: .userGesture) }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                clock = .now
            }
        }
        .background(SectionTheme.groupedBackground)
        .navigationTitle(site.name)
        .inlineNavigationTitle()
    }

    /// Waits for the raise/site-switch refresh to finish, so it appears only
    /// when a refresh could not bring Home current, never over cache about to update.
    @ViewBuilder private var staleNotice: some View {
        // Reads `clock` only to redraw each minute: it pauses in the background, so
        // after a raise it lags, and fresh readings would look like future ones.
        if coordinator.refreshSettled, DashboardPresentation.homeNeedsRefresh(readingTimes, now: max(clock, .now)) {
            AvailabilityBanner(
                message: "Some readings are over an hour old or unavailable. Pull down to refresh.",
                symbol: "clock.badge.exclamationmark"
            )
        }
    }

    private var readingTimes: [Date?] {
        var dates: [Date?] = []
        if let power {
            dates.append(power.sources.liveStatusAt)
            dates.append(power.sources.stateOfChargeAt)
        }
        if let live {
            dates.append(live.sources.energyDataThrough)
            if let timing = live.activeLoadTiming {
                dates.append(timing.energyDataThrough ?? live.sources.energyDataThrough)
            }
        }
        if let bill { dates.append(bill.sources.energyDataThrough) }
        // A failed request with nothing cached shows as unavailable, so it counts as stale too.
        if power == nil, coordinator.livePowerIsUnavailable { dates.append(nil) }
        if live == nil, coordinator.live.isUnavailable { dates.append(nil) }
        if bill == nil, coordinator.bill.isUnavailable { dates.append(nil) }
        return dates
    }

    private var liveSection: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            // Use the actual clock even when a resumed timeline delivers a past entry.
            liveSection(now: .now)
        }
    }

    private func liveSection(now: Date) -> some View {
        let livePowerIsCurrent = !coordinator.livePowerIsUnavailable && power.map {
            DashboardPresentation.liveFreshnessNotice($0.sources.liveStatusAt, now: now) == nil
        } == true
        return VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Live power")
            if let power {
                let charge = MobileLiveResponse.validatedStateOfCharge(
                    power.stateOfCharge, takenAt: power.sources.stateOfChargeAt, now: now
                )
                StatusCard {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .center, spacing: 12) {
                                Text(charge.map { "\(Int($0.rounded()))%" } ?? "--")
                                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                                    .monospacedDigit()
                                    .contentTransition(reduceMotion ? .identity : .numericText())
                                    .accessibilityLabel(
                                        charge.map { "Battery charge \(Int($0.rounded())) percent" }
                                            ?? "Battery charge unknown"
                                    )
                                HStack(alignment: .center, spacing: 4) {
                                    Image(systemName: DashboardPresentation.batterySymbol(
                                        powerWatts: livePowerIsCurrent ? power.live.batteryPower : 0,
                                        stateOfCharge: charge))
                                        .font(.system(size: 44, weight: .bold))
                                        .foregroundStyle(charge == nil ? Color.secondary : Color.green)
                                        .accessibilityHidden(true)
                                    if livePowerIsCurrent
                                        && DashboardPresentation.batteryDirection(
                                            powerWatts: power.live.batteryPower
                                        ) == .discharging {
                                        DischargeSymbol()
                                            .stroke(Color.secondary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                            .frame(width: 16, height: 16)
                                            .accessibilityHidden(true)
                                            .transition(.opacity.combined(with: .scale(scale: 0.85)))
                                    }
                                }
                            }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(
                            (livePowerIsCurrent
                                ? DashboardPresentation.batteryDescription(
                                    stateOfCharge: charge, powerWatts: power.live.batteryPower
                                )
                                : "Battery \(charge.map { "\(Int($0.rounded()))%" } ?? "--"), flow unknown")
                        )
                        Divider()
                        LivePowerFlowCards(flow: DashboardPresentation.powerFlow(
                            solarPower: power.live.solarPower, loadPower: power.live.loadPower,
                            batteryPower: power.live.batteryPower, gridPower: power.live.gridPower,
                            sourceTime: power.sources.liveStatusAt,
                            isUnavailable: coordinator.livePowerIsUnavailable, now: now
                        ))
                    }
                }
            } else if coordinator.live.isUnavailable {
                EmptyCard(symbol: "bolt.slash", title: "Live readings unavailable", message: "Try again when your connection is available.")
            } else {
                LoadingCard(title: "Loading live readings")
            }
        }
    }

    private var todaySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading(
                coordinator.live.isRestored ? "Energy · \(live?.site.localDate ?? "Last visit")" : "Today so far"
            )
            if let live, live.sources.energyDataThrough == nil {
                EmptyCard(symbol: "chart.bar", title: "No energy data yet", message: "Today’s totals will appear after the first energy sample is recorded.")
            } else if let today = live?.today {
                StatusCard {
                    VStack(alignment: .leading, spacing: 16) {
                        adaptiveGrid(TodayEnergyPresentation.tiles(
                            homeKwh: today.homeKwh, solarKwh: today.solarKwh,
                            gridNetKwh: today.gridNetKwh, batteryNetKwh: today.batteryNetKwh
                        ))

                    }
                }
            } else {
                EmptyCard(symbol: "chart.bar", title: "Energy data unavailable", message: "No energy samples are available yet.")
            }
        }
    }

    private var billNavigation: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Current Bill")
            if let bill {
                Button { onOpenTab(.bill) } label: {
                    StatusCard(theme: .bill, fillAlignment: .leading) {
                        HStack(spacing: 16) {
                            Image(systemName: "dollarsign.circle.fill")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.indigo)
                                .frame(width: 48, height: 48)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(DashboardPresentation.currency(bill.currentBill.estimatedCost, code: bill.currentBill.currency))
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(.primary)
                                    .monospacedDigit()
                                Text("\(DashboardPresentation.date(bill.currentBill.cycleStart, timeZoneIdentifier: siteTimeZone)) – \(DashboardPresentation.date(bill.currentBill.cycleEnd, timeZoneIdentifier: siteTimeZone))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Opens the Bill tab")
                }
                .buttonStyle(.plain)
                .pointerHoverEffect()
            } else {
                StatusCard(theme: .bill) {
                    HStack(spacing: 12) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text(coordinator.bill.isUnavailable ? "Bill estimate unavailable" : "Bill estimate is loading")
                            .font(.body.weight(.medium))
                        Spacer()
                    }
                }
            }
        }
    }

    private var loadTimingNavigation: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Smart Shift")
            let summary = DashboardPresentation.loadTimingSummary(
                live?.activeLoadTiming,
                hasTariff: DashboardPresentation.hasActiveTariff(label: live?.activeTariff),
                isStale: false,
                currencyCode: bill?.currentBill.currency
            )
            Button { onOpenTab(.smartShift) } label: {
                StatusCard(theme: .loadTiming, fillAlignment: .leading) {
                    HStack(spacing: 14) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(.teal)
                            .frame(width: 48, height: 48)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(summary.title)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            if let rate = summary.rate {
                                Text(rate)
                                    .font(.subheadline.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(.primary)
                            }
                            if let balance = summary.balance {
                                Text(balance)
                                    .font(.footnote)
                                    .foregroundStyle(summary.isBanked ? .green : .secondary)
                            }
                            if let message = summary.message {
                                Text(message)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(summary.accessibilityLabel)
                .accessibilityHint("Opens Smart Shift")
            }
            .buttonStyle(.plain)
            .pointerHoverEffect()
        }
    }

    private var siteTimeZone: String { bill?.site.timezone ?? live?.site.timezone ?? "UTC" }

    private func adaptiveGrid(_ tiles: [MetricTile]) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            AnyView(VStack(spacing: 10) {
                ForEach(tiles.indices, id: \.self) { tiles[$0] }
            })
        } else {
            AnyView(LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(tiles.indices, id: \.self) { tiles[$0] }
            })
        }
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(.title3.weight(.bold))
            .accessibilityAddTraits(.isHeader)
    }

}

extension EnvironmentValues {
    /// Set by the two-column layout so cards stretch to the tallest card in their row.
    @Entry var dashboardCardsFillHeight = false
}

private struct StatusCard<Content: View>: View {
    var theme: SectionTheme? = nil
    /// Where the content sits when the card is stretched to fill its row.
    var fillAlignment: Alignment = .topLeading
    @ViewBuilder let content: Content
    @Environment(\.dashboardCardsFillHeight) private var fillsHeight
    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: fillsHeight ? .infinity : nil, alignment: fillAlignment)
            .background {
                Group {
                    if let theme {
                        theme.cardBackground
                    } else {
                        SectionTheme.secondaryGroupedBackground
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.primary.opacity(0.045), lineWidth: 1))
    }
}

// All four cards keep their identity as the layout changes their column and row.
// This animates role changes without repeated energy-flow animation or duplicate views.
struct LivePowerFlowCards: View {
    let flow: DashboardPresentation.PowerFlow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var cards: [DashboardPresentation.PowerCard] { flow.supplying + flow.receiving }
    private var flowIsUnknown: Bool { cards.allSatisfy { $0.role == .unknown } }

    var body: some View {
        PowerFlowLayout(stacked: dynamicTypeSize.isAccessibilitySize) {
            heading(flowIsUnknown ? "Last readings" : "Supplying", column: 0)
            heading(flowIsUnknown ? "Flow unknown" : "Receiving", column: 1)
            ForEach(DashboardPresentation.PowerSource.allCases) { source in
                if let card = cards.first(where: { $0.id == source }) {
                    tile(card)
                        .layoutValue(key: FlowColumn.self, value: flow.supplying.contains(card) ? 0 : 1)
                        .layoutValue(key: FlowRow.self, value: (flow.supplying.firstIndex(of: card) ?? flow.receiving.firstIndex(of: card) ?? 0) + 1)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: flow.supplying.map(\.id))
        .transaction { if reduceMotion { $0.disablesAnimations = true } }
    }

    private func heading(_ title: String, column: Int) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
            .accessibilitySortPriority(column == 0 ? 100 : 50)
            .layoutValue(key: FlowColumn.self, value: column)
    }

    private func tile(_ card: DashboardPresentation.PowerCard) -> some View {
        let symbol: String
        let tint: Color
        switch card.id {
        case .solar: symbol = "sun.max.fill"; tint = .orange
        case .home: symbol = "house.fill"; tint = .blue
        case .grid: symbol = card.role == .unknown || card.role == .idle ? "powerplug" : (card.role == .supplying ? "arrow.down.to.line" : "arrow.up.to.line"); tint = .gray
        case .battery: symbol = card.role == .receiving ? "battery.100percent.bolt" : "battery.100percent"; tint = .green
        }
        let role = card.role == .supplying ? "Supplying power" : (card.role == .receiving ? "Receiving power" : nil)
        return MetricTile(title: card.id.title, value: card.watts.map(DashboardPresentation.power) ?? "--",
                          detail: card.detail, symbol: symbol, tint: tint,
                          showsDetail: card.role != .unknown,
                          isMuted: card.role == .idle || card.role == .unknown,
                          numericValue: card.watts, spokenRole: role)
            .accessibilitySortPriority(flow.supplying.firstIndex(of: card).map { Double(99 - $0) }
                ?? Double(49 - (flow.receiving.firstIndex(of: card) ?? 0)))
    }
}

private struct FlowColumn: LayoutValueKey { static let defaultValue = 0 }
private struct FlowRow: LayoutValueKey { static let defaultValue = 0 }

private struct PowerFlowLayout: Layout {
    var stacked: Bool
    private let spacing: CGFloat = 10

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let useStack = stacked || width < 280
        let cardWidth = useStack ? width : (width - spacing) / 2
        let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: cardWidth, height: nil)) }
        var result = Array(repeating: CGRect.zero, count: subviews.count)
        var y: CGFloat = 0
        if useStack {
            for column in 0...1 {
                let indices = subviews.indices.filter { subviews[$0][FlowColumn.self] == column }
                    .sorted { subviews[$0][FlowRow.self] < subviews[$1][FlowRow.self] }
                for index in indices {
                    result[index] = CGRect(x: 0, y: y, width: cardWidth, height: sizes[index].height)
                    y += sizes[index].height + spacing
                }
            }
        } else {
            let maxRow = subviews.map { $0[FlowRow.self] }.max() ?? 0
            for row in 0...maxRow {
                let indices = subviews.indices.filter { subviews[$0][FlowRow.self] == row }
                let height = indices.map { sizes[$0].height }.max() ?? 0
                for index in indices {
                    result[index] = CGRect(x: CGFloat(subviews[index][FlowColumn.self]) * (cardWidth + spacing),
                                           y: y, width: cardWidth, height: height)
                }
                y += height + spacing
            }
        }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        return CGSize(width: width, height: frames(width: width, subviews: subviews).map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let positions = frames(width: bounds.width, subviews: subviews)
        for index in subviews.indices {
            let frame = positions[index]
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                                  anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

struct AvailabilityBanner: View {
    let message: String
    let symbol: String
    var body: some View {
        Label(message, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(.orange)
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.11), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
    }
}

struct EmptyCard: View {
    let symbol: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: symbol).font(.title).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}

private struct LoadingCard: View {
    let title: String
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(title).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}

struct DischargeSymbol: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let midY = rect.midY
        let h = rect.height
        let w = rect.width

        // Horizontal stem from leading edge to bar 1
        let bar1X = rect.minX + w * (10.0 / 18.0)
        path.move(to: CGPoint(x: rect.minX, y: midY))
        path.addLine(to: CGPoint(x: bar1X, y: midY))

        // Bar 1 (tallest: full height)
        path.move(to: CGPoint(x: bar1X, y: midY - h * 0.5))
        path.addLine(to: CGPoint(x: bar1X, y: midY + h * 0.5))

        // Bar 2 (medium: 10/18 height)
        let bar2X = rect.minX + w * (14.0 / 18.0)
        path.move(to: CGPoint(x: bar2X, y: midY - h * (5.0 / 18.0)))
        path.addLine(to: CGPoint(x: bar2X, y: midY + h * (5.0 / 18.0)))

        // Bar 3 (shortest: 4/18 height)
        let bar3X = rect.minX + w * (18.0 / 18.0)
        path.move(to: CGPoint(x: bar3X, y: midY - h * (2.0 / 18.0)))
        path.addLine(to: CGPoint(x: bar3X, y: midY + h * (2.0 / 18.0)))

        return path
    }
}
