import SwiftUI

/// Each Home card's phase, and the invisible placeholders that keep a waiting
/// card the size of the loaded one.
extension DashboardView {
    private static func status<Response>(_ state: DashboardEndpointState<Response>) -> HomeEndpointStatus {
        HomeEndpointStatus(hasResponse: state.response != nil, wait: state.freshReadingWait)
    }

    func livePhase(at now: Date) -> HomeCardPhase {
        let summary = Self.status(coordinator.live)
        // On an older server without the fast route, the summary is the only source.
        let power = coordinator.usesLivePowerEndpoint ? Self.status(coordinator.power) : summary
        return HomeLoadingPresentation.livePhase(power: power, live: summary, now: now)
    }

    /// Today and Smart Shift both come from the summary.
    func summaryPhase(at now: Date) -> HomeCardPhase {
        HomeLoadingPresentation.phase(Self.status(coordinator.live), now: now)
    }

    func billPhase(at now: Date) -> HomeCardPhase {
        HomeLoadingPresentation.phase(Self.status(coordinator.bill), now: now)
    }

    var cardTransition: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98))
    }

    var cardAnimation: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .smooth }

    // MARK: Placeholders

    var livePlaceholder: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center, spacing: 12) {
                Text(verbatim: "100%")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                Image(systemName: "battery.100percent")
                    .font(.system(size: 44, weight: .bold))
            }
            Divider()
            LivePowerFlowCards(flow: DashboardPresentation.powerFlow(.init(
                solarPower: 4000, loadPower: 1000, batteryPower: -3000, gridPower: 0,
                sourceTime: .now, isUnavailable: false)))
        }
    }

    var todayPlaceholder: some View {
        adaptiveGrid(TodayEnergyPresentation.tiles(homeKwh: 0, solarKwh: 0, gridNetKwh: 0, batteryNetKwh: 0))
    }

    var billPlaceholder: some View {
        billCardContent(cost: "$000.00", cycle: "Jan 1 – Jan 31")
    }

    var smartShiftPlaceholder: some View {
        smartShiftCardContent(DashboardPresentation.LoadTimingSummary(
            title: "Placeholder", rate: "$0.00", balance: "0 kWh", message: nil, accessibilityLabel: ""))
    }

    // MARK: Card content shared by the loaded cards and their placeholders

    func billCardContent(cost: String, cycle: String) -> some View {
        HStack(spacing: 16) {
            Image(systemName: AppTab.bill.systemImage)
                .symbolVariant(.fill)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.emphasis)
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(cost)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.primary)
                    .monospacedDigit()
                Text(cycle)
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

    func smartShiftCardContent(_ summary: DashboardPresentation.LoadTimingSummary) -> some View {
        HStack(spacing: 14) {
            Image(systemName: AppTab.smartShift.systemImage)
                .symbolVariant(.fill)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.emphasis)
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
}
