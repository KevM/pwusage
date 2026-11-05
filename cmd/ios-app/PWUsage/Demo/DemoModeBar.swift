import SwiftUI

/// Sits below the tab bar for the whole demo, so nobody mistakes the sample
/// home for their own. Tapping it offers the ways out.
struct DemoModeBar: View {
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text("In Demo Mode")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.onEmphasis)
                .frame(maxWidth: .infinity, minHeight: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.emphasis.ignoresSafeArea(edges: .bottom))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows options for leaving the demo")
    }
}

/// The bar's sheet, and what an external launch shows while in the demo.
struct DemoModeSheet: View {
    let onSignIn: () -> Void
    let onKeepExploring: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "house.lodge")
                .font(.largeTitle)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("You're looking at a sample home, not your own.")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 12) {
                Button(action: onSignIn) {
                    Text("Sign in with Tesla")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .emphasisProminentButton()
                Button(action: onKeepExploring) {
                    Text("Keep exploring")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: 420)
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .presentationDetents([.medium])
    }
}

#Preview("Demo bar") {
    VStack {
        Spacer()
        DemoModeBar(onTap: {})
    }
}

#Preview("Demo sheet") {
    Color.clear.sheet(isPresented: .constant(true)) {
        DemoModeSheet(onSignIn: {}, onKeepExploring: {})
    }
}
