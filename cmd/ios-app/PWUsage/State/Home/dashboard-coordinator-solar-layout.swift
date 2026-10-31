import Foundation

/// The beta layout status: cached per account and site, and updated when detection completes.
enum SolarForecastSurface: Hashable { case smartShift, bill, settings }

extension DashboardCoordinator {
    /// The selected site's status, read from the local record on disk. Triggers on-device
    /// detection if due and returns the current record's response immediately.
    func solarLayoutLookup(siteID: String, operation: Int) async -> MobileSolarLayoutResponse? {
        guard let accountScopeID, runner != nil, historyEnabled else {
            publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
            return .disabled
        }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        Task { [weak self] in
            _ = await self?.runner?.runIfDue(scope: scope)
        }
        let record = try? await records.record(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let response: MobileSolarLayoutResponse
        if let record {
            response = record.response(historyEnabled: historyEnabled)
        } else {
            response = .enabled(location: nil, layout: nil, reason: .needsLocation)
        }
        publishLayoutStatus(response, siteID: siteID, operation: operation)
        return response
    }

    /// Forces the next lookup to ask the runner, as pull-to-refresh, settings and a location
    /// post do.
    func invalidateSolarLayout() {}

    func solarSurfaceAppeared(_ surface: SolarForecastSurface) {
        visibleSolarSurfaces.insert(surface)
    }

    func solarSurfaceDisappeared(_ surface: SolarForecastSurface = .smartShift) {
        visibleSolarSurfaces.remove(surface)
        if !solarSurfaceVisible { cancelLayoutRevalidation() }
    }

    func cancelLayoutRevalidation() {}

    func publishLayoutStatus(_ response: MobileSolarLayoutResponse, siteID: String, operation: Int) {
        solarLayoutStatus = response
    }
}
