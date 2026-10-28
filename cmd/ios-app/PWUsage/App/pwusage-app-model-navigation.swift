import Combine
import SwiftUI

extension PWUsageAppModel {
    func refreshDashboard(trigger: DashboardCoordinator.RefreshTrigger = .userGesture) async {
        if sessionVerified {
            await coordinator?.refreshAll(trigger: trigger)
        } else {
            await reloadSitesAfterSignIn()
        }
    }

    func selectSite(_ site: MobileSite) {
        guard selectedSiteID != site.id else { return }
        selectedSiteID = site.id
        userDefaults.set(site.id, forKey: Self.selectedSiteDefaultsKey)
        coordinator?.selectSite(site.id)
    }

    func selectTab(_ tab: AppTab) {
        selectedTab = tab
        userDefaults.set(tab.rawValue, forKey: Self.selectedTabDefaultsKey)
    }

    func openNavigationURL(_ url: URL) async {
        if url == DashboardLink.url {
            dismissCompetingPresentations()
            externalNavigationID = UUID()
            selectTab(.home)
            return
        }
        guard url.scheme == "pwusage", url.host == "battery-hold" else { return }
        guard let siteID = BatteryHoldLink.siteID(from: url) else {
            pendingBatteryHoldSiteID = nil
            dismissCompetingPresentations()
            batteryHoldNavigationMessage = "Choose a site in the Battery Saver control’s configuration, then try again."
            return
        }
        await openBatteryHold(siteID: siteID)
    }

    func openBatteryHold(siteID: String) async {
        pendingBatteryHoldSiteID = siteID
        batteryHoldNavigationMessage = nil
        dismissCompetingPresentations()
        // Even a warm launch rechecks the current account's sites. A saved picker
        // entry and the dashboard cache are never evidence of current access.
        await reloadSitesAfterSignIn()
    }

    /// The loading overlay and the launcher alert both live on the root view, so
    /// anything already presented above it would hide them. An external launch
    /// closes those before it starts waiting on the network.
    func dismissCompetingPresentations() {
        isSitePickerPresented = false
        coordinator?.presentedSheet = nil
    }

    /// Dismissing the launcher alert abandons the request. Without this the
    /// pending site survives and hijacks the next successful site load.
    func cancelBatteryHoldNavigation() {
        pendingBatteryHoldSiteID = nil
        batteryHoldNavigationMessage = nil
    }

    func resolveBatteryHoldNavigation() {
        guard let requestedID = pendingBatteryHoldSiteID else { return }
        pendingBatteryHoldSiteID = nil
        guard let site = sites.first(where: { $0.id == requestedID }) else {
            batteryHoldNavigationMessage = "This control’s site is no longer available to this account. Choose an available site in the control’s configuration."
            return
        }
        selectSite(site)
        // Rebuild only for an external route: this drops the old navigation path
        // and every dashboard/detail modal before the new host opens the sheet.
        externalNavigationID = UUID()
        selectedTab = .smartShift
        coordinator?.isBatteryHoldSheetPresented = true
    }
}
