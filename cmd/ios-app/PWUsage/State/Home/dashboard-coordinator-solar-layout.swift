import Foundation

/// The beta layout status: cached per account and site, and updated when detection completes.
enum SolarForecastSurface: Hashable { case smartShift, bill, settings }

extension DashboardCoordinator {
    /// The selected site's status, read from the local record on disk. Triggers on-device
    /// detection if due and returns the current record's response immediately.
    func solarLayoutLookup(siteID: String, operation: Int) async -> MobileSolarLayoutResponse? {
        isPerformingSolarLayoutLookup = true
        defer { isPerformingSolarLayoutLookup = false }
        guard let accountScopeID, let runner else {
            publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
            return .disabled
        }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        let bypassTTL = layoutInvalidated
        layoutInvalidated = false
        let isEnabled = try? await history.isEnabled(scope: scope)
        let isSynced = (try? await history.isSynced(scope: scope, within: 86_400, now: now())) == true
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let isSyncedWithinTTL = !bypassTTL && isSynced
        if isSyncedWithinTTL, !historyEnabled || isEnabled == false {
            historyEnabled = false
            publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
            return .disabled
        }
        let record = try? await records.record(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let needsSync = (record == nil || isEnabled == false) && !isSyncedWithinTTL
        if needsSync {
            let syncResult = await runner.syncHistory(scope: scope)
            guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
            guard case .synced = syncResult else {
                historyEnabled = false
                publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
                return .disabled
            }
            historyEnabled = true
        } else {
            Task { [weak self] in
                _ = await self?.runner?.runIfDue(scope: scope)
            }
        }
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let currentRecord = try? await records.record(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let response = currentRecord?.response(historyEnabled: historyEnabled)
            ?? .enabled(location: nil, layout: nil, reason: .needsLocation)
        publishLayoutStatus(response, siteID: siteID, operation: operation)
        return response
    }

    /// Forces the next lookup to ask the runner, as pull-to-refresh, settings and a location
    /// post do.
    func invalidateSolarLayout() {
        layoutInvalidated = true
    }

    func solarSurfaceAppeared(_ surface: SolarForecastSurface) {
        visibleSolarSurfaces.insert(surface)
    }

    func solarSurfaceDisappeared(_ surface: SolarForecastSurface = .smartShift) {
        visibleSolarSurfaces.remove(surface)
        if !solarSurfaceVisible { cancelLayoutRevalidation() }
    }

    func cancelLayoutRevalidation() {}

    func publishLayoutStatus(_ response: MobileSolarLayoutResponse, siteID: String, operation: Int) {
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        solarLayoutStatus = response
    }
}
