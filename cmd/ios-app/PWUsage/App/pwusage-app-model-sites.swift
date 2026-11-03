import Combine
import Foundation
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
        await activateSolarCloudSession(accountScopeID: accountScopeID, generation: generation)
        guard generation == siteInstallGeneration else { return }
        await forecastService?.activateAccountScope(accountScopeID)
        guard generation == siteInstallGeneration else { return }
        // An authorized site list is the sign-in a paused job was waiting for.
        await historyOnboarding?.resumePaused(accountScopeID: accountScopeID, reason: .signIn)
        guard generation == siteInstallGeneration else { return }
        cache?.storeSites(availableSites)
        sessionVerified = true
        startSolarCloudSync()
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
            updateHistoryOnboarding()
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
        updateHistoryOnboarding()
    }

    /// Onboarding runs for the selected site of a verified, foreground session, and nowhere else.
    func updateHistoryOnboarding() {
        guard let historyOnboarding else { return }
        guard sceneIsActive, sessionVerified, screenState == .signedIn,
              let accountScopeID, let selectedSiteID else {
            Task { await historyOnboarding.deactivate() }
            return
        }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
        historyOnboarding.activate(scope: scope)
    }

    /// Waits only for local cleanup of a previous session, never for iCloud. A failed
    /// cleanup is retried once here. If it fails again, the dashboard still publishes but
    /// solar layout synchronization stays closed (its writes are rejected) until a later
    /// authorization retries the cleanup.
    func activateSolarCloudSession(accountScopeID: String, generation: Int) async {
        let activation = await solarCloudSync.activate(adoptSolarCloudSession(accountScopeID: accountScopeID))
        guard activation == .cleanupRequired else { return }
        if (try? await solarSessionCleanup.signOut()) != nil,
           await solarCloudSync.activate(adoptSolarCloudSession(accountScopeID: accountScopeID)) == .active {
            return
        }
        if generation == siteInstallGeneration {
            signInMessage = "Could not clear local solar forecast data. Try again."
        }
    }

    /// Cached-to-verified restoration and repeated authorization keep one session.
    func adoptSolarCloudSession(accountScopeID: String) -> SolarCloudSession {
        if let session = solarCloudSession, session.isValid, session.accountScopeID == accountScopeID {
            return session
        }
        let session = solarCloudSync.issueSession(accountScopeID: accountScopeID)
        solarCloudSession = session
        return session
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
    nonisolated static let accountScopeDefaultsKey = "pwusage.localAccountScopeID"
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
        await forecastService?.activateAccountScope(nil)
    }
}
