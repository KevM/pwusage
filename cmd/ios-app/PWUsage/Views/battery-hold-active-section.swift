import SwiftUI

struct BatteryHoldActiveSection: View {
    let hold: BatteryHold
    let timeZone: String
    let now: Date
    let canRestore: Bool
    let onRestore: () -> Void
    var liveActivity: BatteryHoldLiveActivityOffer? = nil
    var canShowLiveActivity = false
    var onShowLiveActivity: () -> Void = {}
    @State private var isConfirmingRestore = false

    var body: some View {
        Section("Battery Saver On") {
            Label("Saving your Powerwall at \(BatteryHoldPresentation.reserveText(hold.targetReserve))", systemImage: "battery.100percent")
                .font(.headline)
            if let monitoring = hold.monitoring {
                VStack(alignment: .leading, spacing: 4) {
                    if let load = BatteryHoldPresentation.loadSummary(monitoring, at: now) {
                        Text(load)
                    }
                    Text(BatteryHoldPresentation.nextCheckText(monitoring, at: now))
                        .foregroundStyle(.secondary)
                }
            } else if hold.mode == .auto {
                Text("Waiting for the first check")
                    .foregroundStyle(.secondary)
            }
            Text(BatteryHoldPresentation.restorationText(hold, timeZone: timeZone, at: now))
            if let liveActivity {
                switch liveActivity {
                case .showing:
                    Text("Following Battery Saver on your Lock Screen.").foregroundStyle(.secondary)
                case .available:
                    Button("Show on Lock Screen", action: onShowLiveActivity).disabled(!canShowLiveActivity)
                case .disabled:
                    Text("Turn on Live Activities for pwusage in Settings to follow Battery Saver on your Lock Screen.")
                        .foregroundStyle(.secondary)
                }
                if liveActivity != .disabled, let limit = BatteryHoldPresentation.liveActivityLimitText(hold, at: now) {
                    Text(limit).font(.footnote).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("Info") {
                LabeledContent("Original backup reserve", value: "\(hold.originalReserve)%")
                if hold.mode == .auto {
                    Text("Home usage is checked every 15 minutes.")
                    Text(BatteryHoldPresentation.safetyText(hold, timeZone: timeZone))
                }
                if let monitoring = hold.monitoring {
                    Text(BatteryHoldPresentation.monitoringText(monitoring, at: now))
                    LabeledContent("Last checked", value: monitoring.checkedAt.formatted(date: .omitted, time: .shortened))
                    if let sampledAt = monitoring.sampledAt {
                        LabeledContent("Usage reading", value: sampledAt.formatted(date: .omitted, time: .shortened))
                    }
                }
            }
            Button("Turn Off Battery Saver", systemImage: "stop.circle", action: confirmRestore)
                .disabled(!canRestore)
                .confirmationDialog("Turn Off Battery Saver?", isPresented: $isConfirmingRestore, titleVisibility: .visible) {
                    Button("Turn Off Battery Saver", action: onRestore).disabled(!canRestore)
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text(BatteryHoldPresentation.restoreConfirmationText(originalReserve: hold.originalReserve))
                }
        }
    }

    private func confirmRestore() { isConfirmingRestore = true }
}
