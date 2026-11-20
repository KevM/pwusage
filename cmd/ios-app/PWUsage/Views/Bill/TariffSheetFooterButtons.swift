import SwiftUI

/// The Rate Plans footer: add a plan, or check with an AI assistant.
struct TariffSheetFooterButtons: View {
    let onAddPlan: () -> Void
    let onAiHandoff: () -> Void

    var body: some View {
        Button(action: onAddPlan) {
            Label("Add Rate Plan", systemImage: "plus.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .emphasisProminentButton()
        .controlSize(.large)
        .padding(.top, 4)

        Button(action: onAiHandoff) {
            Label("Check with Your AI Assistant", systemImage: "sparkles")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}
