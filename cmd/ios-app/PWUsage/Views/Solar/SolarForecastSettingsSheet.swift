import SwiftUI

/// Smart Shift presents the Solar System screen as a sheet; Settings pushes it.
struct SolarForecastSettingsSheet: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SolarSystemView(coordinator: coordinator, site: site, status: nil)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
