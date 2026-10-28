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
        .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .named(Self.scrollContentSpace))
        } action: {
            liveCardFrameChanged($0)
        }
    }
}
