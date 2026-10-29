import SwiftUI

extension DashboardView {
    var liveSection: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            // Use the actual clock even when a resumed timeline delivers a past entry.
            liveSection(now: .now)
        }
    }

    /// The flow and validated charge both the Live card and the bar's scoreboard show.
    func liveReadings(now: Date) -> (flow: DashboardPresentation.PowerFlow, charge: Double?)? {
        guard let power else { return nil }
        let flow = DashboardPresentation.powerFlow(
            solarPower: power.live.solarPower, loadPower: power.live.loadPower,
            batteryPower: power.live.batteryPower, gridPower: power.live.gridPower,
            sourceTime: power.sources.liveStatusAt,
            isUnavailable: coordinator.livePowerIsUnavailable, now: now
        )
        let charge = MobileLiveResponse.validatedStateOfCharge(
            power.stateOfCharge, takenAt: power.sources.stateOfChargeAt, now: now
        )
        return (flow, charge)
    }

    func liveScoreboard(now: Date) -> DashboardPresentation.LiveScoreboard? {
        liveReadings(now: now).flatMap {
            DashboardPresentation.liveScoreboard(flow: $0.flow, stateOfCharge: $0.charge)
        }
    }

    private func liveSection(now: Date) -> some View {
        let livePowerIsCurrent = !coordinator.livePowerIsUnavailable && power.map {
            DashboardPresentation.liveFreshnessNotice($0.sources.liveStatusAt, now: now) == nil
        } == true
        return VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Live power")
            if let power, let readings = liveReadings(now: now) {
                StatusCard {
                    VStack(alignment: .leading, spacing: 18) {
                        batteryHeader(power: power, charge: readings.charge, isCurrent: livePowerIsCurrent)
                        Divider()
                        LivePowerFlowCards(flow: readings.flow)
                    }
                }
            } else if coordinator.live.isUnavailable {
                EmptyCard(
                    symbol: "bolt.slash",
                    title: "Live readings unavailable",
                    message: "Try again when your connection is available."
                )
            } else {
                LoadingCard(title: "Loading live readings")
            }
        }
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .named(DashboardView.scrollContentSpace))
        } action: {
            liveCardFrameChanged($0)
        }
    }

    private func batteryHeader(power: MobileLivePowerResponse, charge: Double?, isCurrent: Bool) -> some View {
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
                        powerWatts: isCurrent ? power.live.batteryPower : 0,
                        stateOfCharge: charge))
                        .font(.system(size: 44, weight: .bold))
                        .foregroundStyle(charge == nil ? Color.secondary : Color.green)
                        .accessibilityHidden(true)
                    if isCurrent
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
            (isCurrent
                ? DashboardPresentation.batteryDescription(
                    stateOfCharge: charge, powerWatts: power.live.batteryPower
                )
                : "Battery \(charge.map { "\(Int($0.rounded()))%" } ?? "--"), flow unknown")
        )
    }
}
