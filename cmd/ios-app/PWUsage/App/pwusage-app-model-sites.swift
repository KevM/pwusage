import Combine
import SwiftUI

extension PWUsageAppModel {
    /// Claims ownership of the published site state, superseding any attempt that has
    /// not finished. A retry is deliberately *not* blocked on the attempt it replaces —
    /// §3.2 requires it to run to completion while the older attempt is still parked —
    /// so the guard is on publishing, not on entry.
    func claimSiteInstall() -> Int {
        siteInstallGeneration += 1
        return siteInstallGeneration
    }

    /// Publishes `availableSites`, unless `generation` has been superseded.
    ///
    /// Two attempts can be in flight at once — the root `.task` is cancelled on
    /// disappear, but an API or actor call that ignores cancellation keeps running,
    /// and the re-appearing `.task` starts a second one — so the losing attempt
    /// reaches this function too. A single check on entry is therefore not enough:
    /// a loser that is already inside when the winner starts publishing resumes
    /// *after* the winner and overwrites the selected site and the coordinator.
    /// The generation is compared again after the `await` for that reason.
    ///
    /// The pre-`await` writes are deliberately left unguarded. §3.2 requires
    /// `sites` to be populated while the state is still `.bootstrapping`, because
    /// that is what makes the screen retryable rather than a permanent spinner;
    /// a superseded attempt reaching them has already lost a race the newer
    /// attempt wins again immediately afterwards.
    func installAuthorizedSites(_ availableSites: [MobileSite], generation: Int) async {
        guard generation == siteInstallGeneration else { return }
        sites = availableSites
        authService.restoreAuthenticatedSession()
        let accountScopeID = ensureAccountScopeID()
        await forecastStore.activateAccountScope(accountScopeID)
        await forecastService?.activateAccountScope(accountScopeID)
        await solarCloudSync.start()
        guard generation == siteInstallGeneration else { return }
        cache?.storeSites(availableSites)
        sessionVerified = true
        controlSiteStore?.save(availableSites.map { BatteryHoldControlSite(id: $0.id, name: $0.name) })
        liveActivities?.sitesAuthorized(availableSites)
        guard !availableSites.isEmpty else {
            resolveBatteryHoldNavigation()
            coordinatorAuthSubscription = nil
            coordinator?.authenticationInvalidated()
            coordinator?.scenePhaseChanged(isActive: false)
            coordinator = nil
            selectedSiteID = nil
            screenState = .noSites
            return
        }

        // The saved default belongs to the user and only `selectSite` changes it.
        // A control launch moves the dashboard for this visit, and an ordinary
        // reload keeps whatever is already on screen, so neither rewrites it.
        let savedID = userDefaults.string(forKey: Self.selectedSiteDefaultsKey)
        let defaultSite = availableSites.first(where: { $0.id == savedID }) ?? availableSites[0]
        let chosen = availableSites.first(where: { $0.id == pendingBatteryHoldSiteID })
            ?? availableSites.first(where: { $0.id == selectedSiteID })
            ?? defaultSite
        selectedSiteID = chosen.id
        userDefaults.set(defaultSite.id, forKey: Self.selectedSiteDefaultsKey)

        if let coordinator, coordinator.selectedSiteID == chosen.id {
            coordinator.authenticationRestored()
            coordinator.scenePhaseChanged(isActive: sceneIsActive)
        } else {
            coordinatorAuthSubscription = nil
            coordinator?.authenticationInvalidated()
            coordinator?.scenePhaseChanged(isActive: false)
            installCoordinator(siteID: chosen.id, accountScopeID: accountScopeID)
            coordinator?.scenePhaseChanged(isActive: sceneIsActive)
        }
        screenState = .signedIn
        resolveBatteryHoldNavigation()
    }

    func installCoordinator(siteID: String, accountScopeID: String) {
        let nextCoordinator = coordinatorFactory(siteID, accountScopeID)
        nextCoordinator.restoreLaunchCache(cache, sessionVerified: sessionVerified)
        nextCoordinator.batteryHoldActivityObserver = liveActivities
        coordinator = nextCoordinator
        coordinatorAuthSubscription = nextCoordinator.$requiresSignIn
            .removeDuplicates()
            .sink { [weak self] required in
                guard required else { return }
                Task { @MainActor in await self?.sessionExpired() }
            }
    }

    static let selectedSiteDefaultsKey = "pwusage.selectedSiteID"
    static let accountScopeDefaultsKey = "pwusage.localAccountScopeID"
    static let selectedTabDefaultsKey = "pwusage.selectedTab"

    /// The next session starts on Home, not on whatever tab this one ended on.
    func clearSelectedTab() {
        selectedTab = .home
        userDefaults.removeObject(forKey: Self.selectedTabDefaultsKey)
    }

    func ensureAccountScopeID() -> String {
        if let existing = userDefaults.string(forKey: Self.accountScopeDefaultsKey), !existing.isEmpty {
            accountScopeID = existing
            return existing
        }
        let created = UUID().uuidString.lowercased()
        userDefaults.set(created, forKey: Self.accountScopeDefaultsKey)
        accountScopeID = created
        return created
    }

    func clearAccountScopeID() async {
        accountScopeID = nil
        userDefaults.removeObject(forKey: Self.accountScopeDefaultsKey)
        await forecastStore.activateAccountScope(nil)
        await forecastService?.activateAccountScope(nil)
    }
}
