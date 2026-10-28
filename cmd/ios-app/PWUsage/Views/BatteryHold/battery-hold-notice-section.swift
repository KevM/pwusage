import SwiftUI

struct BatteryHoldNoticeSection: View {
    let notice: BatteryHold
    let canDismiss: Bool
    let onDismiss: () -> Void

    var body: some View {
        Section {
            Label("Reserve Changed", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(BatteryHoldPresentation.noticeText(notice))
            Button("Dismiss Notice", action: onDismiss).disabled(!canDismiss)
        }
    }
}
