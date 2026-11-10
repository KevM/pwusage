import SwiftUI

/// The Smart Shift tab's bottom accessory while Battery Saver is on. Tapping opens the Battery Saver sheet.
struct BatteryHoldAccessory: View {
    let model: BatteryHoldAccessoryModel
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: "bolt.shield.fill")
                    .foregroundStyle(Color.emphasis)
                    .accessibilityHidden(true)
                Text(model.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityIdentifier("battery-hold-accessory")
    }
}
