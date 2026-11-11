import Foundation

extension DashboardCoordinator {
    /// The selected site's stored record, for the layout editor: what was entered and what was detected.
    func manualLayoutRecord() async -> SolarLayoutRecord? {
        guard let scope = manualLayoutScope else { return nil }
        return try? await records.record(scope: scope)
    }

    /// Saves the entered layout, or clears it with nil. Returns whether it was stored.
    func saveManualLayout(_ layout: ManualSolarLayout?) async -> Bool {
        guard let scope = manualLayoutScope else { return false }
        do {
            try await records.setManualLayout(layout?.normalized(), scope: scope)
            return true
        } catch {
            return false
        }
    }

    private var manualLayoutScope: SolarForecastSiteScope? {
        accountScopeID.map { SolarForecastSiteScope(accountScopeID: $0, siteID: selectedSiteID) }
    }
}
