import SwiftUI

struct DashboardView: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    let onChooseSite: () -> Void
    let onSignOut: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var live: MobileLiveResponse? { coordinator.live.response }
    private var bill: MobileBillResponse? { coordinator.bill.response }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if coordinator.live.isUnavailable {
                        AvailabilityBanner(message: "Live data is temporarily unavailable. Showing the last successful reading with its original source time.", symbol: "wifi.exclamationmark")
                    }
                    if coordinator.bill.isUnavailable {
                        AvailabilityBanner(message: "The bill estimate could not be refreshed. Showing the last successful estimate.", symbol: "clock.badge.exclamationmark")
                    }
                    liveSection
                    todaySection
                    billNavigation
                    loadTimingNavigation
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .refreshable {
                await coordinator.refreshAll(trigger: .userGesture)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(site.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Switch site", systemImage: "arrow.left.arrow.right", action: onChooseSite)
                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: onSignOut)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More options")
                }
            }
            .navigationDestination(for: BillDestination.self) { _ in
                BillView(coordinator: coordinator, site: site)
            }
            .navigationDestination(for: LoadTimingDestination.self) { _ in
                LoadTimingView(coordinator: coordinator, site: site)
            }
        }
    }

    private var liveSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Live power")
                .font(.title3.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            if let live {
                StatusCard {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .center, spacing: 12) {
                                Text(live.stateOfCharge.map { "\(Int($0.rounded()))%" } ?? "--")
                                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                                    .monospacedDigit()
                                    .contentTransition(.numericText())
                                    .accessibilityLabel(live.stateOfCharge.map { "Battery charge \(Int($0.rounded())) percent" } ?? "Battery charge unknown")
                                HStack(alignment: .center, spacing: 4) {
                                    Image(systemName: batterySymbol(live.live.batteryPower, stateOfCharge: live.stateOfCharge))
                                        .font(.system(size: 44, weight: .bold))
                                        .foregroundStyle(.green)
                                        .accessibilityHidden(true)
                                    if DashboardPresentation.batteryDirection(powerWatts: live.live.batteryPower) == .discharging {
                                        DischargeSymbol()
                                            .stroke(Color.secondary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                            .frame(width: 16, height: 16)
                                            .accessibilityHidden(true)
                                            .transition(.opacity.combined(with: .scale(scale: 0.85)))
                                    }
                                }
                            }
                            if live.stateOfCharge != nil,
                               let ageLabel = DashboardPresentation.chargeAgeLabel(live.sources.stateOfChargeAt) {
                                Text(ageLabel)
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(
                            DashboardPresentation.batteryDescription(stateOfCharge: live.stateOfCharge, powerWatts: live.live.batteryPower)
                            + (DashboardPresentation.chargeAgeLabel(live.sources.stateOfChargeAt).map { ", \($0)" } ?? "")
                        )
                        Divider()
                        adaptiveGrid([
                            MetricTile(title: "Home", value: DashboardPresentation.power(live.live.loadPower), detail: "Using", symbol: "house.fill", tint: .blue),
                            MetricTile(title: "Solar", value: DashboardPresentation.power(live.live.solarPower), detail: "Producing", symbol: "sun.max.fill", tint: .orange),
                            MetricTile(title: "Grid", value: DashboardPresentation.power(live.live.gridPower), detail: gridDirection(live.live.gridPower), symbol: live.live.gridPower >= 0 ? "arrow.down.to.line" : "arrow.up.to.line", tint: .gray),
                            MetricTile(title: "Battery", value: DashboardPresentation.batteryPower(live.live.batteryPower), detail: DashboardPresentation.batteryPowerDetail(live.live.batteryPower), symbol: batterySymbol(live.live.batteryPower, stateOfCharge: live.stateOfCharge), tint: .green)
                        ])
                    }
                }
                if let notice = DashboardPresentation.liveFreshnessNotice(live.sources.liveStatusAt) {
                    Label(notice, systemImage: "clock.badge.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityElement(children: .combine)
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
            sectionHeading("Today so far", subtitle: live.map { DashboardPresentation.freshness($0.sources.energyDataThrough, staleAfter: 30 * 60) } ?? "Waiting for energy data")
            if let live, live.sources.energyDataThrough == nil {
                EmptyCard(symbol: "chart.bar", title: "No energy data yet", message: "Today’s totals will appear after the first energy sample is recorded.")
            } else if let today = live?.today {
                StatusCard {
                    VStack(alignment: .leading, spacing: 16) {
                        adaptiveGrid([
                            MetricTile(title: "Home", value: DashboardPresentation.energy(today.homeKwh), symbol: "house.fill", tint: .blue),
                            MetricTile(title: "Solar", value: DashboardPresentation.energy(today.solarKwh), symbol: "sun.max.fill", tint: .orange),
                            MetricTile(title: "Grid", value: DashboardPresentation.signedGridEnergy(today.gridNetKwh), detail: today.gridNetKwh > 0 ? "Net import" : (today.gridNetKwh < 0 ? "Net export" : "Balanced"), symbol: "powerplug", tint: .gray),
                            MetricTile(title: "Battery", value: DashboardPresentation.signedBatteryEnergy(today.batteryNetKwh), detail: today.batteryNetKwh > 0 ? "Net discharge" : (today.batteryNetKwh < 0 ? "Net charge" : "Balanced"), symbol: "battery.100percent", tint: .green)
                        ])
                        if live?.activeTariff == nil || live?.todayComplete == false {
                            Divider()
                            VStack(alignment: .leading, spacing: 6) {
                                if live?.activeTariff == nil {
                                    Label("No active tariff is configured", systemImage: "info.circle")
                                }
                                if live?.todayComplete == false {
                                    Label("Some energy intervals are missing", systemImage: "exclamationmark.triangle")
                                }
                            }
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        }
                        if let tariff = live?.activeTariff {
                            Label("Active tariff · \(tariff)", systemImage: "tag")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(.secondary)
                                .accessibilityElement(children: .combine)
                        }
                    }
                }
            } else {
                EmptyCard(symbol: "chart.bar", title: "Energy data unavailable", message: "No energy samples are available yet.")
            }
        }
    }

    private var billNavigation: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Current bill", subtitle: bill.map { "Calculated · \(DashboardPresentation.freshness($0.sources.calculatedAt, staleAfter: 60 * 60).replacingOccurrences(of: "Updated ", with: ""))" } ?? "Waiting for estimate")
            if let bill {
                NavigationLink(value: BillDestination.current) {
                    StatusCard {
                        HStack(spacing: 16) {
                            Image(systemName: "doc.text")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.indigo)
                                .frame(width: 48, height: 48)
                                .background(.indigo.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
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
                    .accessibilityHint("View bill cycle dates and tariff period details")
                }
                .buttonStyle(.plain)
                .hoverEffect()
            } else {
                StatusCard {
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
            sectionHeading("Load timing", subtitle: live.map {
                "Live summary · \(DashboardPresentation.freshness($0.activeLoadTiming?.energyDataThrough ?? $0.sources.energyDataThrough, staleAfter: 30 * 60).replacingOccurrences(of: "Updated ", with: ""))"
            } ?? "Waiting for active tariff")
            let summarySource = live?.activeLoadTiming?.energyDataThrough ?? live?.sources.energyDataThrough
            let summaryIsStale = coordinator.live.isUnavailable || (summarySource.map { Date.now.timeIntervalSince($0) > 30 * 60 } ?? false)
            let summary = DashboardPresentation.loadTimingSummary(
                live?.activeLoadTiming,
                hasTariff: DashboardPresentation.hasActiveTariff(label: live?.activeTariff),
                isStale: summaryIsStale,
                currencyCode: bill?.currentBill.currency
            )
            NavigationLink(value: LoadTimingDestination.current) {
                StatusCard {
                    HStack(spacing: 14) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(.teal)
                            .frame(width: 48, height: 48)
                            .background(.teal.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
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
                                    .foregroundStyle(balance.hasPrefix("Surplus") ? .green : .secondary)
                            }
                            if let message = summary.message {
                                Text(message)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if let freshness = summary.freshness {
                                Text(freshness)
                                    .font(.caption)
                                    .foregroundStyle(.orange)
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
                .accessibilityHint("View load timing and estimate appliance costs by tariff period")
            }
            .buttonStyle(.plain)
            .hoverEffect()
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

    private func sectionHeading(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.title3.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func batterySymbol(_ watts: Double, stateOfCharge: Double? = nil) -> String {
        let isCharging = DashboardPresentation.batteryDirection(powerWatts: watts) == .charging
        let level: String
        if let stateOfCharge {
            switch Int(stateOfCharge.rounded()) {
            case ..<13: level = "0percent"
            case 13..<38: level = "25percent"
            case 38..<63: level = "50percent"
            case 63..<88: level = "75percent"
            default: level = "100percent"
            }
        } else {
            level = "100percent"
        }
        return isCharging ? "battery.\(level).bolt" : "battery.\(level)"
    }

    private func gridDirection(_ watts: Double) -> String {
        watts > 50 ? "Importing" : (watts < -50 ? "Exporting" : "Balanced")
    }
}

private struct BillDestination: Hashable { static let current = Self() }
private struct LoadTimingDestination: Hashable { static let current = Self() }

private struct StatusCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(16)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.primary.opacity(0.045), lineWidth: 1))
    }
}

private struct MetricTile: View {
    let title: String
    let value: String
    var detail: String? = nil
    let symbol: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(tint)
                .labelStyle(.titleAndIcon)
            Text(value)
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value)\(detail.map { ", \($0)" } ?? "")")
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
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
