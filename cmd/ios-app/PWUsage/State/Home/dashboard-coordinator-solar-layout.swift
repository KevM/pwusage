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
        let eligibility = await cachedEligibility(scope: scope, bypassTTL: bypassTTL)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        if eligibility.isConfirmedDisabled {
            historyEnabled = false
            publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
            return .disabled
        }
        let record = try? await records.record(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        let needsSync = eligibility.needsSync(record: record)
        var syncResult: SolarHistorySyncResult?
        if needsSync {
            let step = await executeLookupSync(scope: scope, runner: runner, siteID: siteID, operation: operation)
            if step.shouldExit { return step.response }
            syncResult = step.result
        } else {
            Task { [weak self] in
                _ = await self?.runner?.runIfDue(scope: scope)
            }
        }
        let currentRecord = try? await records.record(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
        guard let response = resolveLayoutResponse(
            record: currentRecord, needsSync: needsSync, syncResult: syncResult
        ) else {
            return nil
        }
        publishLayoutStatus(response, siteID: siteID, operation: operation)
        return response
    }

    private struct CachedEligibility {
        let isSyncedWithinTTL: Bool
        let isEnabled: Bool?
        let isConfirmedDisabled: Bool

        func needsSync(record: SolarLayoutRecord?) -> Bool {
            !isSyncedWithinTTL && (record == nil || isEnabled == false)
        }
    }

    private func cachedEligibility(scope: SolarForecastSiteScope, bypassTTL: Bool) async -> CachedEligibility {
        let isEnabled = try? await history.isEnabled(scope: scope)
        let isSynced = (try? await history.isSynced(scope: scope, within: 86_400, now: now())) == true
        let withinTTL = !bypassTTL && isSynced
        let isConfirmed = withinTTL && (!historyEnabled || isEnabled == false)
        return CachedEligibility(isSyncedWithinTTL: withinTTL, isEnabled: isEnabled, isConfirmedDisabled: isConfirmed)
    }

    private struct LookupSyncOutcome {
        let shouldExit: Bool
        let response: MobileSolarLayoutResponse?
        let result: SolarHistorySyncResult?
    }

    private func executeLookupSync(
        scope: SolarForecastSiteScope, runner: SolarLayoutDetectionRunner, siteID: String, operation: Int
    ) async -> LookupSyncOutcome {
        let result = await runner.syncHistory(scope: scope)
        guard operation == forecastGeneration, siteID == selectedSiteID else {
            return LookupSyncOutcome(shouldExit: true, response: nil, result: nil)
        }
        if case .disabled = result {
            historyEnabled = false
            publishLayoutStatus(.disabled, siteID: siteID, operation: operation)
            return LookupSyncOutcome(shouldExit: true, response: .disabled, result: result)
        }
        if case .synced = result {
            historyEnabled = true
        }
        return LookupSyncOutcome(shouldExit: false, response: nil, result: result)
    }

    private func resolveLayoutResponse(
        record: SolarLayoutRecord?, needsSync: Bool, syncResult: SolarHistorySyncResult?
    ) -> MobileSolarLayoutResponse? {
        if record == nil && needsSync && syncResult == nil {
            return nil
        }
        return record?.response(historyEnabled: historyEnabled)
            ?? .enabled(location: nil, layout: nil, reason: .needsLocation)
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
