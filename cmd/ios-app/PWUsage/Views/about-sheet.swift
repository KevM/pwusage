import SwiftUI

struct AboutSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    AboutSheet()
}
