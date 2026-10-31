import Foundation

extension PWUsageAppModel {
    /// A background launch does not bootstrap the dashboard or poll Tesla. Revalidate the
    /// already-saved account/site, then use the same forecast service as the foreground.
    func refreshBackgroundForecast() async {
        guard !Task.isCancelled, !isSigningOut, !ProcessInfo.processInfo.isLowPowerModeEnabled,
              let backgroundAPI = try? BackgroundSolarForecastRefresh.api() else { return }
        _ = await refreshBackgroundForecast(
            using: backgroundAPI, now: Date(), lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
    }

    func refreshBackgroundForecast(
        using backgroundAPI: any PWUsageApplicationAPI,
        now: Date,
        lowPowerMode: Bool
    ) async -> Bool {
        guard !lowPowerMode, !Task.isCancelled, !isSigningOut,
              let service = forecastService,
              let account = userDefaults.string(forKey: Self.accountScopeDefaultsKey), !account.isEmpty,
              let siteID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey), !siteID.isEmpty else {
            return false
        }
        let generation = siteInstallGeneration
        let isCurrent = {
            !Task.isCancelled && !self.isSigningOut && self.siteInstallGeneration == generation
                && self.userDefaults.string(forKey: Self.accountScopeDefaultsKey) == account
                && self.userDefaults.string(forKey: Self.selectedSiteDefaultsKey) == siteID
        }
        do {
            let authorized = try await backgroundAPI.fetchSites()
            guard isCurrent(), authorized.contains(where: { $0.id == siteID }) else { return false }
            let scope = SolarForecastSiteScope(accountScopeID: account, siteID: siteID)
            guard let record = try await solarRecords.record(scope: scope), isCurrent(),
                  case .enabled(let location?, let layout?, _) = record.response(historyEnabled: true) else {
                return false
            }
            let isStale = (try? await solarHistory.isSynced(scope: scope, within: 86_400, now: now)) != true
            if isStale {
                let syncResult = try? await solarHistory.sync(scope: scope, api: backgroundAPI, now: now)
                if case .disabled = syncResult { return false }
            }
            let context = try await backgroundAPI.fetchLoadPlanningContext(siteID: siteID)
                .validating(siteID: siteID, now: now)
            let hours = (try? await solarHistory.hourlyActuals(scope: scope, now: now)) ?? []
            guard isCurrent(), let zone = TimeZone(identifier: context.site.timezone) else { return false }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            guard let end = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: now)), end > now else {
                return false
            }
            let request = SolarForecastRequest(
                scope: scope, siteTimeZone: zone, window: DateInterval(start: now, end: end),
                manual: false, layout: layout, location: location, automaticOnly: true
            )
            guard isCurrent() else { return false }
            let publication = await service.publication(for: request, actuals: hours)
            return isCurrent() && publication != nil
        } catch {
            return false
        }
    }
}
