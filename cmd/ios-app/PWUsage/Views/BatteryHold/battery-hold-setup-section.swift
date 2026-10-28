import SwiftUI

struct BatteryHoldSetupSection: View {
    let stateOfCharge: Double?
    let hasTariff: Bool
    let requiresReserveChoice: Bool
    let canStart: Bool
    let onStart: (BatteryHoldChoice) -> Void
    @State private var mode: BatteryHoldMode = .auto
    @State private var hours = 4
    @State private var reserve = 100

    private var plan: BatteryHoldReservePlan? { stateOfCharge.flatMap(BatteryHoldReservePlan.make) }
    private var showsChoice: Bool { requiresReserveChoice || plan?.requiresChoice == true }
    private var target: Int { showsChoice ? reserve : (plan?.target ?? 0) }

    var body: some View {
        Section("Turn On Battery Saver") {
            if let stateOfCharge, let plan {
                LabeledContent("Battery charge", value: "\(Int(stateOfCharge.rounded(.down)))%")
                if showsChoice {
                    Picker("Backup reserve", selection: $reserve) {
                        Text("80%").tag(80)
                        Text("100%").tag(100)
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: 44)
                    Text("80% lets your Powerwall power your home down to 80%, then saves the rest. 100% keeps it from discharging at all.")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    LabeledContent("Backup reserve", value: BatteryHoldPresentation.reserveText(plan.target))
                    if plan.target == 80 && stateOfCharge > 80 {
                        Text("Your Powerwall can discharge to 80% before Battery Saver keeps the rest.")
                            .foregroundStyle(.secondary)
                    }
                }
                Picker("Duration", selection: $mode) {
                    Text("Auto-detect").tag(BatteryHoldMode.auto)
                    Text("Fixed duration").tag(BatteryHoldMode.timer)
                }
                if mode == .auto {
                    Text("Restores your backup reserve automatically when the job finishes.")
                        .foregroundStyle(.secondary)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 64))]) {
                        ForEach([2, 4, 6, 8], id: \.self) { duration in
                            Button { hours = duration } label: {
                                Text("\(duration) h").frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.bordered)
                            .tint(hours == duration ? .accentColor : .secondary)
                            .accessibilityLabel("\(duration) hours")
                            .accessibilityAddTraits(hours == duration ? .isSelected : [])
                        }
                    }
                    Stepper("\(hours) hours", value: $hours, in: 1...24)
                        .accessibilityLabel("Custom Battery Saver duration")
                        .accessibilityValue("\(hours) hours")
                    Text("Stays on for the full duration, even if the job finishes early.")
                        .foregroundStyle(.secondary)
                }
                Button("Turn On at \(BatteryHoldPresentation.reserveText(target))", systemImage: "battery.100percent", action: confirm)
                    .disabled(!canStart)
                    .accessibilityInputLabels(["Turn on Battery Saver", "Battery Saver"])
            } else {
                Text("A recent battery charge reading is needed to turn on Battery Saver. Try again to update it.")
                    .foregroundStyle(.secondary)
            }
            if !hasTariff {
                Text("Add a rate plan on the website before turning on Battery Saver.")
                    .foregroundStyle(.secondary)
            }
        }
        .disabled(!canStart)
    }

    private func confirm() {
        onStart(.init(mode: mode, durationHours: hours, reserveChoice: showsChoice ? reserve : nil))
    }
}
