import Foundation

/// The beta layout status: cached per account and site, revalidated while a solar surface is
/// on screen, and cleared on rejection so no automatic request follows.
extension DashboardCoordinator {
    /// The selected site's status, from cache when still valid. A transient failure falls back
    /// to the last status the server confirmed within six hours; an explicit rejection or a
    /// malformed response clears everything automatic.
    func solarLayoutLookup(siteID: String, operation: Int) async -> MobileSolarLayoutResponse? {
        guard let layoutAPI, let accountScopeID else { return nil }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        let requestTime = now()
        let force = solarLayoutRevalidationRequested
        solarLayoutRevalidationRequested = false
        if !force, let cached = solarLayoutCache[scope],
           (0 ..< cached.lifetime).contains(requestTime.timeIntervalSince(cached.validatedAt)) {
            publishLayoutStatus(cached, siteID: siteID, operation: operation)
            return cached.response
        }
        do {
            let response = try await layoutAPI.fetchSolarLayout(siteID: siteID)
            guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
            let entry = SolarLayoutCacheEntry(response: response, validatedAt: now())
            solarLayoutCache[scope] = entry
            publishLayoutStatus(entry, siteID: siteID, operation: operation)
            return response
        } catch {
            guard operation == forecastGeneration, siteID == selectedSiteID else { return nil }
            if Self.isTransientLayoutFailure(error), let cached = solarLayoutCache[scope],
               (0 ..< SolarLayoutCacheEntry.validationLifetime).contains(now().timeIntervalSince(cached.validatedAt)) {
                return cached.response
            }
            solarLayoutCache[scope] = nil
            solarActualsCache[scope] = nil
            solarLayoutStatus = nil
            return nil
        }
    }

    /// Forces the next lookup to ask the server, as pull-to-refresh, settings and a location
    /// post do.
    func invalidateSolarLayout() {
        solarLayoutRevalidationRequested = true
    }

    func solarSurfaceDisappeared() {
        solarSurfaceVisible = false
        cancelLayoutRevalidation()
    }

    func cancelLayoutRevalidation() {
        solarLayoutRevalidation?.cancel()
        solarLayoutRevalidation = nil
    }

    private func publishLayoutStatus(_ entry: SolarLayoutCacheEntry, siteID: String, operation: Int) {
        solarLayoutStatus = entry.response
        if case .disabled = entry.response, let scope = solarScope { solarActualsCache[scope] = nil }
        scheduleLayoutRevalidation(for: entry, siteID: siteID)
    }

    /// One coalesced revalidation at the transitional status's expiry, while the app is active
    /// and a solar surface is visible. It never promises detection will have finished.
    private func scheduleLayoutRevalidation(for entry: SolarLayoutCacheEntry, siteID: String) {
        guard entry.isTransitional, sceneIsActive, solarSurfaceVisible else {
            cancelLayoutRevalidation()
            return
        }
        guard solarLayoutRevalidation == nil else { return }
        let delay = max(entry.validatedAt.addingTimeInterval(entry.lifetime).timeIntervalSince(now()), 1)
        solarLayoutRevalidation = revalidationScheduler.schedule(after: delay) { [weak self] in
            guard let self else { return }
            solarLayoutRevalidation = nil
            guard siteID == selectedSiteID, sceneIsActive, solarSurfaceVisible, canRequestAccountData else { return }
            invalidateSolarLayout()
            await loadTimingDetailAppeared()
        }
    }

    private static func isTransientLayoutFailure(_ error: any Error) -> Bool {
        switch error as? PWUsageAPIError {
        case .recoverableServerError: true
        case .signInRequired, .requestRejected, .invalidResponse: false
        case nil: true
        }
    }
}
