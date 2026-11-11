import SwiftUI

/// A small sheet for the two things that change at every plug-in: which car it is and how full it is.
/// Edits write straight to the store, so the answer on the card behind the sheet updates as they move.
struct CarQuickEditSheet: View {
    @ObservedObject var store: LoadProfileStore
    let selectedID: String?
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private var car: LoadProfile? {
        selectedID.flatMap { id in store.carProfiles.first { $0.id == id } }
            ?? store.lastEVProfileID.flatMap { store.profile(id: $0) }
            ?? store.carProfiles.first
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.carProfiles.count > 1 {
                        carChips
                    }
                    if let car, let settings = car.carSettings {
                        CarChargeRow(
                            title: "Current charge", value: settings.initialStateOfCharge,
                            range: 0 ... 100,
                            onChange: { setCharge(for: car, current: $0, target: nil) })
                        CarChargeRow(
                            // A fixed range keeps this thumb still while the top slider moves; the store
                            // lifts the target when current passes it.
                            title: "Target charge", value: settings.targetStateOfCharge,
                            range: 0 ... 100,
                            onChange: { setCharge(for: car, current: nil, target: $0) })
                    } else {
                        Text("Add a car in Manage Jobs to set its charge here.")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(20)
            }
            .navigationTitle(car?.name ?? "Car")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.height(340), .large])
        .presentationBackgroundInteraction(.disabled)
        .presentationDragIndicator(.visible)
    }

    private var carChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.carProfiles) { profile in
                    let isSelected = profile.id == car?.id
                    Button { onSelect(profile.id) } label: {
                        Text(profile.name)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .foregroundStyle(isSelected ? Color.onEmphasis : Color.primary)
                            .background(isSelected ? Color.emphasis : Color.secondary.opacity(0.15), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
        }
    }

    private func setCharge(for car: LoadProfile, current: Double?, target: Double?) {
        try? store.updateCarCharge(id: car.id, current: current, target: target)
    }
}

/// One charge level with −5 / +5 buttons and a slider that moves in 5% steps.
private struct CarChargeRow: View {
    let title: String
    let value: Double
    let range: ClosedRange<Double>
    let onChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Text(value.formatted(.number.precision(.fractionLength(0))) + "%")
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
            }
            HStack(spacing: 8) {
                stepButton(systemImage: "minus.circle.fill", label: "Decrease \(title.lowercased()) by 5 percent") {
                    onChange(CarChargeSteps.steppedDown(value))
                }
                Slider(value: Binding(get: { value }, set: { onChange($0) }), in: range, step: CarChargeSteps.step)
                    .accessibilityLabel(title)
                    .accessibilityValue("\(value.formatted(.number.precision(.fractionLength(0)))) percent")
                stepButton(systemImage: "plus.circle.fill", label: "Increase \(title.lowercased()) by 5 percent") {
                    onChange(CarChargeSteps.steppedUp(value))
                }
            }
        }
    }

    private func stepButton(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title2)
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(label)
    }
}
