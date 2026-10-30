import SwiftUI

/// The settings sheet's "Solar Forecast" section for beta sites: what was detected, where the
/// forecast comes from, and the location step. Hidden entirely outside the beta.
struct SolarForecastAutomaticSection: View {
    @ObservedObject var coordinator: DashboardCoordinator
    @State private var isConfirming = false
    @State private var outcome: SolarLocationShareResult?

    private var sourceDescriptor: SolarForecastProviderDescriptor? {
        coordinator.forecastService?.automaticDescriptor
    }

    var body: some View {
        if let status = coordinator.solarLayoutStatus, case .enabled(let location, _, let reason) = status {
            Section {
                ForEach(
                    SolarForecastSettingsStatus.automaticSummary(response: status, source: sourceDescriptor),
                    id: \.self
                ) { line in
                    Text(line)
                }
                if let outcome { SolarLocationOutcomeView(outcome: outcome) }
                Button(buttonTitle(location: location, reason: reason)) { isConfirming = true }
            } header: {
                Text("Solar Forecast")
            } footer: {
                if let source = coordinator.attributionDescriptor(
                    usesSolar: coordinator.solarForecastPublication != nil
                ) {
                    SolarForecastAttributionView(descriptor: source)
                }
            }
            .solarLocationConfirmation(isPresented: $isConfirming, coordinator: coordinator) { outcome = $0 }
        }
    }

    /// A location action is always available, so a declined or failed attempt can be retried.
    private func buttonTitle(location: SolarHomeLocation?, reason: MobileSolarLayoutReason?) -> String {
        if location?.source == .estimated { return "Use My Exact Home Location" }
        return location == nil ? "Use My Home Location" : "Update My Home Location"
    }
}
