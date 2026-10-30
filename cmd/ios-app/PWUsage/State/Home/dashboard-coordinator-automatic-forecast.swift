import Foundation

/// The beta automatic forecast: layout status, measured actuals and the service's
/// publication. Every await is fenced by the forecast generation and selected site.
extension DashboardCoordinator {
    var solarScope: SolarForecastSiteScope? {
        accountScopeID.map { SolarForecastSiteScope(accountScopeID: $0, siteID: selectedSiteID) }
    }

    /// Unknown beta status stays on history until the server confirms a legacy site.
    var usesAutomaticSolarForecast: Bool { layoutAPI != nil && solarLayoutStatus != .disabled }

    /// What forecast consumers treat as the connection: a published automatic forecast is
    /// ready even though Solcast is not connected.
    var forecastConnectionForConsumers: SolarForecastConnectionState {
        if solarForecastPublication != nil { return .ready }
        return usesAutomaticSolarForecast ? .notConnected : solarForecastConnection
    }

    var publishedForecastIntervals: [SolarForecastInterval]? {
        solarForecastPublication?.intervals ?? (usesAutomaticSolarForecast ? nil : solarForecastBatch?.intervals)
    }

    var publishedForecastFetchedAt: Date? {
        solarForecastPublication?.fetchedAt ?? (usesAutomaticSolarForecast ? nil : solarForecastBatch?.fetchedAt)
    }

    /// Shown wherever an automatic forecast is in use.
    var solarForecastAttribution: String? {
        guard let descriptor = solarForecastPublication?.descriptor, descriptor.requirement == .detectedLayout else {
            return nil
        }
        return descriptor.attribution
    }

    /// The already-resolved beta status selects automatic forecasting even with saved credentials.
    func loadAutomaticForecast(
        siteID: String, api: any MobileLoadPlanningDataAPI, operation: Int,
        status: MobileSolarLayoutResponse?, manual: Bool
    ) async {
        solarForecastBatch = nil
        solarForecastConnection = .notConnected
        solarForecastUnavailableCause = nil
        solarForecastLastRefresh = nil
        solarForecastSaveFailure = false
        solarForecastState = solarForecastPublication == nil ? .basic : .loadingWithBasic
        guard let service = forecastService, let scope = solarScope,
              case .enabled(let location?, let layout?, _) = status else {
            clearAutomaticPublication()
            await loadHouseholdPattern(siteID: siteID, api: api, operation: operation)
            return
        }
        let billSuccessBefore = billSuccessGeneration
        async let billRefresh: Void = refreshBill(trigger: .screenAppearance)
        async let actuals = solarActuals(siteID: siteID)
        let outcome = await planningContext(siteID: siteID, api: api)
        await billRefresh
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        householdPattern = outcome.context
        let billSucceeded = billSuccessGeneration > billSuccessBefore || billIsFresh(at: now())
        guard let context = outcome.context, billSucceeded, bill.response?.site.id == siteID,
              bill.response?.site.timezone == context.timeZone,
              let timeZone = TimeZone(identifier: context.timeZone) else {
            clearAutomaticPublication()
            return
        }
        let request = solarRequest(scope: scope, timeZone: timeZone, layout: layout, location: location, manual: manual)
        let publication = await service.publication(for: request, actuals: await actuals)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        guard let publication else {
            clearAutomaticPublication()
            return
        }
        solarForecastPublication = publication
        solarForecastSource = publication.descriptor.id
        loadPlanningContext = context
        solarForecastUnavailableReason = nil
        solarForecastState = .enhanced
    }

    /// Beta correction for a connected Solcast forecast, only when the policy allows it.
    func correctedSolcastBatch(
        _ batch: SolarForecastBatch,
        siteID: String,
        context: LoadTimingForecastEstimator.PlanningContext
    ) async -> SolarForecastBatch {
        guard let service = forecastService, service.correctsCredentialProviders, let scope = solarScope,
              case .enabled = await solarLayoutLookup(siteID: siteID, operation: forecastGeneration),
              let timeZone = TimeZone(identifier: context.timeZone),
              let actuals = await solarActuals(siteID: siteID) else { return batch }
        let fingerprint = SolcastForecastProvider.fingerprint(
            credentialID: batch.credentialID, resourceIDs: batch.resourceIDs
        )
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: scope.accountScopeID, siteID: siteID, providerID: .solcast, fingerprint: fingerprint
        )
        let raw = SolarForecastRawBatch(
            providerID: .solcast, fingerprint: fingerprint, cacheRevision: fingerprint,
            intervals: batch.intervals, fetchedAt: batch.fetchedAt, acClipKw: nil
        )
        let (intervals, _) = await service.corrected(raw, identity: identity, siteTimeZone: timeZone, actuals: actuals)
        return SolarForecastBatch(
            credentialID: batch.credentialID, resourceIDs: batch.resourceIDs, intervals: intervals,
            fetchedAt: batch.fetchedAt
        )
    }

    /// Keeps the selected site's status current for settings, even while Solcast is used.
    func refreshSolarLayoutStatus(siteID: String, operation: Int) async {
        _ = await solarLayoutLookup(siteID: siteID, operation: operation)
    }

    private func solarRequest(
        scope: SolarForecastSiteScope,
        timeZone: TimeZone,
        layout: SolarLayout,
        location: SolarHomeLocation,
        manual: Bool
    ) -> SolarForecastRequest {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = now()
        let end = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: start)) ?? start
        return SolarForecastRequest(
            scope: scope, siteTimeZone: timeZone, window: DateInterval(start: start, end: max(start, end)),
            manual: manual, layout: layout, location: location, automaticOnly: true
        )
    }

    func clearAutomaticPublication() {
        solarForecastBatch = nil
        solarForecastPublication = nil
        solarForecastSource = nil
        loadPlanningContext = nil
        solarForecastState = .basic
    }

    /// Clears the selected site's status, caches and any scheduled revalidation.
    func clearSolarLayoutState() {
        cancelLayoutRevalidation()
        solarLayoutStatus = nil
        solarForecastSource = nil
        solarForecastPublication = nil
        solarSurfaceVisible = false
    }

    // MARK: Actuals

    /// Measured hourly solar for correction, cached for an hour. `nil` when disabled or failed,
    /// which means the forecast is published uncorrected.
    func solarActuals(siteID: String) async -> [MobileSolarActualsHour]? {
        guard let layoutAPI, let accountScopeID else { return nil }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        let requestTime = now()
        if let cached = solarActualsCache[scope],
           (0 ..< SolarActualsCacheEntry.lifetime).contains(requestTime.timeIntervalSince(cached.fetchedAt)) {
            return cached.hours
        }
        let hours: [MobileSolarActualsHour]?
        do {
            guard case .enabled(_, let fetched) = try await layoutAPI.fetchSolarActuals(siteID: siteID) else {
                solarActualsCache[scope] = SolarActualsCacheEntry(hours: nil, fetchedAt: requestTime)
                return nil
            }
            hours = fetched.filter { $0.hourStart < requestTime }
        } catch {
            return nil
        }
        solarActualsCache[scope] = SolarActualsCacheEntry(hours: hours, fetchedAt: requestTime)
        return hours
    }
}
