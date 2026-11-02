import SwiftUI

/// Smart Shift presents the settings as a sheet; Settings pushes `SolarForecastSettingsView`.
struct SolarForecastSettingsSheet: View {
    @ObservedObject var coordinator: DashboardCoordinator
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SolarForecastSettingsView(coordinator: coordinator)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// The solar forecast settings, without navigation of their own.
struct SolarForecastSettingsView: View {
    @ObservedObject var coordinator: DashboardCoordinator

    var body: some View {
        Form {
            SolarForecastAutomaticSection(coordinator: coordinator)
            if coordinator.solarLayoutStatus == nil {
                Section { Text("Checking solar forecast availability…") }
            }
        }
        .navigationTitle("Solar Forecast")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { coordinator.solarSurfaceDisappeared(.settings) }
        .task {
            await coordinator.solarSettingsAppeared()
        }
    }
}
