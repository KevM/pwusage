import SwiftUI

struct BatteryHoldActiveSection: View {
    let hold: BatteryHold
    let timeZone: String
    let now: Date
    let canRestore: Bool
    let onRestore: () -> Void
    @State private var isConfirmingRestore = false

    var body: some View {
        Section("Battery Hold Active") {
            Label("Holding at \(BatteryHoldPresentation.reserveText(hold.targetReserve))", systemImage: "battery.100percent")
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
                Text("Waiting for the first load check")
                    .foregroundStyle(.secondary)
            }
            Text(BatteryHoldPresentation.restorationText(hold, timeZone: timeZone, at: now))
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
            Button("Stop the Battery Hold", systemImage: "stop.circle", action: confirmRestore)
                .disabled(!canRestore)
                .confirmationDialog("Stop the Battery Hold?", isPresented: $isConfirmingRestore, titleVisibility: .visible) {
                    Button("Stop the Battery Hold", action: onRestore).disabled(!canRestore)
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text(BatteryHoldPresentation.restoreConfirmationText(originalReserve: hold.originalReserve))
                }
        }
    }

    private func confirmRestore() { isConfirmingRestore = true }
}
