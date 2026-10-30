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
            let status = try await backgroundAPI.fetchSolarLayout(siteID: siteID)
            guard isCurrent(), case .enabled(let location?, let layout?, _) = status else { return false }
            async let contextResponse = backgroundAPI.fetchLoadPlanningContext(siteID: siteID)
            async let actualsResponse = backgroundAPI.fetchSolarActuals(siteID: siteID)
            let context = try await contextResponse.validating(siteID: siteID, now: now)
            let actuals = try await actualsResponse
            guard isCurrent(), case .enabled(_, let hours) = actuals,
                  let zone = TimeZone(identifier: context.site.timezone) else { return false }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            guard let end = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: now)), end > now else {
                return false
            }
            let request = SolarForecastRequest(
                scope: SolarForecastSiteScope(accountScopeID: account, siteID: siteID),
                siteTimeZone: zone, window: DateInterval(start: now, end: end),
                manual: false, layout: layout, location: location, automaticOnly: true
            )
            guard isCurrent() else { return false }
            let publication = await service.publication(for: request, actuals: hours)
            return isCurrent() && publication != nil
        } catch {
            // Offline, locked-before-first-unlock, revoked sessions, and expiration all keep
            // the last cache. No sign-in UI or retry loop is started from a background task.
            return false
        }
    }
}
