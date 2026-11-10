import SwiftUI

/// Sits below the tab bar for the whole demo, so nobody mistakes the sample
/// home for their own. Tapping it offers the ways out.
struct DemoModeBar: View {
    let onTap: () -> Void
    /// The label sits in the bottom inset instead of above it, which would double the bar's thickness.
    @State private var bottomInset: CGFloat = 0
    @State private var labelHeight: CGFloat = 0

    var body: some View {
        Button(action: onTap) {
            Text("In Demo Mode")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.onEmphasis)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { bottomInset = $0 }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { labelHeight = $0 }
        // Layout height drops to zero when the inset can hold the label, so the bar is just the inset.
        .padding(.bottom, -min(bottomInset, labelHeight))
        // Fill the corners too: on a device with rounded or inset window edges (Duo)
        // the label stays inside the safe area while the color runs to the edge.
        .background(Color.emphasis.ignoresSafeArea(edges: [.bottom, .horizontal]))
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
