import SwiftUI

/// The Home tab's content. It has no navigation chrome of its own: the host
/// supplies the stack (which shows `navigationTitle`), and the summary cards
/// switch tabs through `onOpenTab` rather than pushing duplicate pages.
struct DashboardView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    let onOpenTab: (AppTab) -> Void
    var onRefresh: (() async -> Void)?

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var availableWidth: Double = 0
    /// Re-checks the stale notice each minute; readings age without the view otherwise redrawing.
    @State private var clock = Date.now
    /// False once the Live card scrolls away, which adds the scoreboard under the bar's title.
    @State private var liveCardIsVisible = true
    /// Last measured Live card frame and scroll edge. A class box, so scrolling
    /// updates them without redrawing; only the visibility flip redraws.
    @State private var liveCardTracking = LiveCardTracking()
    nonisolated static let scrollContentSpace = "homeScrollContent"

    var live: MobileLiveResponse? { coordinator.live.response }
    var power: MobileLivePowerResponse? {
        coordinator.power.response ?? live.map(MobileLivePowerResponse.init(snapshot:))
    }
    var bill: MobileBillResponse? { coordinator.bill.response }

    var usesTwoColumns: Bool {
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
                            loadTimingNavigation.frame(maxWidth: .infinity, maxHeight: .infinity,
                                                       alignment: .topLeading)
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
            .coordinateSpace(name: Self.scrollContentSpace)
        }
        .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { availableWidth = $0 }
        // Measured against the edge below the bar: visibility APIs count content
        // under the translucent bar as on screen, so the card would seem visible too long.
        .onScrollGeometryChange(for: Double.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top
        } action: { _, visibleTop in
            liveCardTracking.visibleTop = visibleTop
            updateLiveCardVisibility()
        }
        .refreshable {
            if let onRefresh {
                await onRefresh()
            } else {
                await coordinator.refreshAll(trigger: .userGesture)
            }
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
        .toolbar {
            ToolbarItem(placement: .principal) {
                // Ticks like the Live card so stale readings drop back to the name.
                TimelineView(.periodic(from: .now, by: 60)) { _ in
                    HomeLiveTitle(
                        siteName: site.name,
                        scoreboard: liveCardIsVisible ? nil : liveScoreboard(now: .now)
                    )
                }
            }
        }
    }

    /// Re-run on scroll and when the card moves without one (banner, layout or loading change).
    func liveCardFrameChanged(_ frame: CGRect) {
        liveCardTracking.cardFrame = frame
        updateLiveCardVisibility()
    }

    private func updateLiveCardVisibility() {
        let isVisible = DashboardPresentation.liveCardIsVisible(
            cardMinY: liveCardTracking.cardFrame.minY, cardMaxY: liveCardTracking.cardFrame.maxY,
            visibleTop: liveCardTracking.visibleTop
        )
        if isVisible != liveCardIsVisible { liveCardIsVisible = isVisible }
    }

    /// Waits for the raise/site-switch refresh to finish, so it appears only
    /// when a refresh could not bring Home current, never over cache about to update.
    @ViewBuilder private var staleNotice: some View {
        // Reads `clock` only to redraw each minute: it pauses in the background, so
        // after a raise it lags, and fresh readings would look like future ones.
        if coordinator.refreshSettled, let message = refreshNoticeMessage {
            AvailabilityBanner(message: message, symbol: "clock.badge.exclamationmark")
        }
    }

    private var historyRefreshStatus: MobileLiveResponse.HistoryRefreshStatus? {
        coordinator.live.isRestored ? nil : live?.historyRefresh?.status
    }

    private var refreshNoticeMessage: String? {
        if let message = historyOutcomeMessage {
            return message
        }
        if DashboardPresentation.homeNeedsRefresh(
            readingTimes, energySources: energyReadingTimes, awaitingEnergy: historyRefreshStatus == .awaitingData,
            now: max(clock, .now)
        ) {
            return "Some readings are over an hour old or unavailable. Pull down to refresh."
        }
        return nil
    }

    private var readingTimes: [Date?] {
        var dates: [Date?] = []
        if let power {
            dates.append(power.sources.liveStatusAt)
            dates.append(power.sources.stateOfChargeAt)
        }
        // A failed request with nothing cached shows as unavailable, so it counts as stale too.
        if power == nil, coordinator.livePowerIsUnavailable { dates.append(nil) }
        if live == nil, coordinator.live.isUnavailable { dates.append(nil) }
        if bill == nil, coordinator.bill.isUnavailable { dates.append(nil) }
        return dates
    }

    private var energyReadingTimes: [Date?] {
        var dates: [Date?] = []
        if let live {
            dates.append(live.sources.energyDataThrough)
            if let timing = live.activeLoadTiming {
                dates.append(timing.energyDataThrough ?? live.sources.energyDataThrough)
            }
        }
        if let bill { dates.append(bill.sources.energyDataThrough) }
        return dates
    }

    private var historyOutcomeMessage: String? {
        DashboardPresentation.historyRefreshMessage(
            historyRefreshStatus, isUnavailable: coordinator.live.isUnavailable,
            energySources: energyReadingTimes, now: max(clock, .now)
        )
    }

    private var missingEnergyMessage: String {
        historyOutcomeMessage ?? "Today’s totals will appear after the first energy sample is recorded."
    }

    private var todaySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading(
                coordinator.live.isRestored ? "Energy · \(live?.site.localDate ?? "Last visit")" : "Today so far"
            )
            Group {
                if summaryPhase(at: .now) == .loaded, let live {
                    todayContent(live)
                } else {
                    HomeWaitingCard(card: .today, phase: summaryPhase(at:)) { todayPlaceholder }
                }
            }
            .transition(cardTransition)
        }
        .animation(cardAnimation, value: summaryPhase(at: .now) == .loaded)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.today")
    }

    @ViewBuilder private func todayContent(_ live: MobileLiveResponse) -> some View {
        if live.sources.energyDataThrough == nil {
            EmptyCard(symbol: "chart.bar", title: "No energy data yet", message: missingEnergyMessage)
        } else {
            StatusCard {
                adaptiveGrid(TodayEnergyPresentation.tiles(
                    homeKwh: live.today.homeKwh, solarKwh: live.today.solarKwh,
                    gridNetKwh: live.today.gridNetKwh, batteryNetKwh: live.today.batteryNetKwh
                ))
            }
        }
    }

    private var billNavigation: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Current Bill")
            Group {
                if billPhase(at: .now) == .loaded, let bill {
                    billButton(bill)
                } else {
                    HomeWaitingCard(card: .bill, phase: billPhase(at:), theme: .bill) { billPlaceholder }
                }
            }
            .transition(cardTransition)
        }
        .animation(cardAnimation, value: billPhase(at: .now) == .loaded)
    }

    private func billButton(_ bill: MobileBillResponse) -> some View {
        let cycleStart = DashboardPresentation.date(bill.currentBill.cycleStart, timeZoneIdentifier: siteTimeZone)
        let cycleEnd = DashboardPresentation.date(bill.currentBill.cycleEnd, timeZoneIdentifier: siteTimeZone)
        return Button { onOpenTab(.bill) } label: {
            StatusCard(theme: .bill, fillAlignment: .leading) {
                billCardContent(
                    cost: DashboardPresentation.currency(bill.currentBill.estimatedCost,
                                                         code: bill.currentBill.currency),
                    cycle: "\(cycleStart) – \(cycleEnd)"
                )
            }
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens the Bill tab")
            .accessibilityIdentifier("home.bill")
        }
        .buttonStyle(.plain)
        .pointerHoverEffect()
    }

    private var loadTimingNavigation: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Smart Shift")
            Group {
                if summaryPhase(at: .now) == .loaded, let live {
                    smartShiftButton(live)
                } else {
                    HomeWaitingCard(card: .smartShift, phase: summaryPhase(at:), theme: .loadTiming) {
                        smartShiftPlaceholder
                    }
                }
            }
            .transition(cardTransition)
        }
        .animation(cardAnimation, value: summaryPhase(at: .now) == .loaded)
    }

    private func smartShiftButton(_ live: MobileLiveResponse) -> some View {
        let summary = DashboardPresentation.loadTimingSummary(
            live.activeLoadTiming,
            hasTariff: DashboardPresentation.hasActiveTariff(label: live.activeTariff),
            currencyCode: bill?.currentBill.currency
        )
        return Button { onOpenTab(.smartShift) } label: {
            StatusCard(theme: .loadTiming, fillAlignment: .leading) {
                smartShiftCardContent(summary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(summary.accessibilityLabel)
            .accessibilityHint("Opens Smart Shift")
        }
        .buttonStyle(.plain)
        .pointerHoverEffect()
    }

    var siteTimeZone: String { bill?.site.timezone ?? live?.site.timezone ?? "UTC" }

    func adaptiveGrid(_ tiles: [MetricTile]) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            AnyView(VStack(spacing: 10) {
                ForEach(tiles.indices, id: \.self) { tiles[$0] }
            })
        } else {
            AnyView(LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                              spacing: 10) {
                    ForEach(tiles.indices, id: \.self) { tiles[$0] }
                })
        }
    }

    func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(.title3.weight(.bold))
            .accessibilityAddTraits(.isHeader)
    }
}

extension EnvironmentValues {
    /// Set by the two-column layout so cards stretch to the tallest card in their row.
    @Entry var dashboardCardsFillHeight = false
}

// All four cards keep their identity as the layout changes their column and row.
// This animates role changes without repeated energy-flow animation or duplicate views.

/// Scroll-driven measurements kept out of SwiftUI's change tracking.
final class LiveCardTracking {
    var cardFrame: CGRect = .zero
    var visibleTop: Double = 0
}
