import SwiftUI

/// The About page. Pushed from Settings, so it has no stack or Done button of
/// its own; the host supplies those.
struct AboutSheet: View {
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("pwusage")
                        .font(.title2.weight(.bold))
                    Text("Your home energy, Powerwall, and electricity costs at a glance.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
            Section {
                Link(destination: AppConfiguration.defaultAPIOrigin.appendingPathComponent("support")) {
                    Label("Support", systemImage: "questionmark.circle")
                }
                Link(destination: AppConfiguration.defaultAPIOrigin.appendingPathComponent("privacy")) {
                    Label("Privacy Policy", systemImage: "hand.raised")
                }
            }
        }
        .navigationTitle("About")
        .inlineNavigationTitle()
    }
}

#Preview {
    NavigationStack { AboutSheet() }
}
