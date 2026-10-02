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
        Section("Hold Battery for Charging") {
            if let stateOfCharge, let plan {
                LabeledContent("Battery charge", value: "\(Int(stateOfCharge.rounded(.down)))%")
                if showsChoice {
                    Picker("Backup reserve", selection: $reserve) {
                        Text("80%").tag(80)
                        Text("100%").tag(100)
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: 44)
                    Text("80% lets the battery serve the load down to 80%, then holds. 100% prevents discharge completely.")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    LabeledContent("Hold reserve", value: BatteryHoldPresentation.reserveText(plan.target))
                    if plan.target == 80 && stateOfCharge > 80 {
                        Text("The battery can discharge to 80% before holding.")
                            .foregroundStyle(.secondary)
                    }
                }
                Picker("Duration", selection: $mode) {
                    Text("Auto-detect").tag(BatteryHoldMode.auto)
                    Text("Fixed duration").tag(BatteryHoldMode.timer)
                }
                if mode == .auto {
                    Text("Automatically restores battery reserve when we detect that the load is done.")
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
                        .accessibilityLabel("Custom hold duration")
                        .accessibilityValue("\(hours) hours")
                    Text("Holds for the full duration, even if charging finishes early.")
                        .foregroundStyle(.secondary)
                }
                Button("Hold at \(BatteryHoldPresentation.reserveText(target))", systemImage: "battery.100percent", action: confirm)
                    .disabled(!canStart)
                    .accessibilityInputLabels(["Hold battery"])
            } else {
                Text("A recent battery charge reading is needed to start a hold. Try again to update it.")
                    .foregroundStyle(.secondary)
            }
            if !hasTariff {
                Text("Configure a tariff on the website before starting a battery hold.")
                    .foregroundStyle(.secondary)
            }
        }
        .disabled(!canStart)
    }

    private func confirm() {
        onStart(.init(mode: mode, durationHours: hours, reserveChoice: showsChoice ? reserve : nil))
    }
}
