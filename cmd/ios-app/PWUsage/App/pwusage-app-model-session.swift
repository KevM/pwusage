import Combine
import SwiftUI

extension PWUsageAppModel {
    func openSitePicker() {
        guard screenState == .signedIn, !sites.isEmpty else { return }
        isSitePickerPresented = true
    }

    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        defer { isSigningOut = false }
        // First, while the session cookie can still unregister this device's pushes.
        await liveActivities?.signOut()
        pendingBatteryHoldSiteID = nil
        batteryHoldNavigationMessage = nil
        screenState = .signedOut
        signInMessage = nil
        teardownCoordinator()
        var cleanupFailed = false
        do { try await authService.logout() }
        catch let error as MobileAuthService.AuthError where error == .forecastCleanupFailed { cleanupFailed = true }
        catch { /* A remote logout failure does not prevent local sign-out. */ }
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        isSitePickerPresented = false
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        clearSelectedTab()
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed ? "Could not clear local solar forecast data. Try again." : nil
    }

    func sessionExpired() async {
        guard !isSigningOut else { return }
        await invalidateSession(message: "Your session expired. Sign in to continue.")
    }

    func invalidateSession(message: String?) async {
        guard !isSigningOut else { return }
        teardownCoordinator()
        await liveActivities?.sessionInvalidated()
        var cleanupFailed = false
        do { try await authService.invalidateAuthenticatedSession() }
        catch { cleanupFailed = true }
        isSitePickerPresented = false
        coordinator = nil
        coordinatorAuthSubscription = nil
        sites = []
        selectedSiteID = nil
        userDefaults.removeObject(forKey: Self.selectedSiteDefaultsKey)
        clearSelectedTab()
        await clearAccountScopeID()
        screenState = .signedOut
        signInMessage = cleanupFailed
            ? "Could not clear local solar forecast data. Try again."
            : message
    }

    /// The coordinator must not outlive the session. `authenticationInvalidated`
    /// discards in-flight work; going inactive is what actually stops the
    /// polling timer, which otherwise keeps a strong reference and keeps asking
    /// for authenticated data after the user has signed out.
    func teardownCoordinator() {
        siteInstallGeneration += 1
        sessionVerified = false
        cache?.clear()
        controlSiteStore?.clear()
        coordinatorAuthSubscription = nil
        coordinator?.authenticationInvalidated()
        coordinator?.scenePhaseChanged(isActive: false)
    }
}
