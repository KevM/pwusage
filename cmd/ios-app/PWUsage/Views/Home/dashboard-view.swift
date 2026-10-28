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
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var availableWidth: Double = 0
    /// Re-checks the stale notice each minute; readings age without the view otherwise redrawing.
    @State private var clock = Date.now

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

    var siteTimeZone: String { bill?.site.timezone ?? live?.site.timezone ?? "UTC" }

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
