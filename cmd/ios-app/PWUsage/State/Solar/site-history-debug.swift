import Foundation
import SwiftUI

/// Debug-build controls on Site History, for watching a real import from scratch. Created only
/// in Debug builds; Release never shows them.
struct SiteHistoryDebugActions {
    let scope: SolarForecastSiteScope
    /// Forgets this site's onboarding progress and on-device history, then starts again.
    let reset: @MainActor () async -> Void
    /// Clears the solar layout and home location from iCloud and on this device.
    let clearCloudLayout: @MainActor () async -> Void
    /// Rereads the status after a setting changes.
    let refresh: @MainActor () async -> Void
}

#if DEBUG
    /// Per-site Debug settings, kept in the standard defaults.
    enum SiteHistoryDebugSettings {
        /// Treat the site as having no usable layout, so onboarding runs the full search. The
        /// stored layout is untouched (clearing it would sync the change through iCloud).
        static func ignoresLayoutKey(_ scope: SolarForecastSiteScope) -> String {
            "debug.siteHistory.ignoresLayout.\(scope.accountScopeID)|\(scope.siteID)"
        }

        static func ignoresLayout(_ scope: SolarForecastSiteScope, defaults: UserDefaults = .standard) -> Bool {
            defaults.bool(forKey: ignoresLayoutKey(scope))
        }
    }

    extension PWUsageAppModel {
        /// The selected site's onboarding progress and on-device solar history are forgotten;
        /// the server's history, the layout record and other sites are untouched.
        func resetSiteHistoryOnDevice() async {
            guard let historyOnboarding, let accountScopeID, let selectedSiteID else { return }
            let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
            await historyOnboarding.forget(scope: scope)
            try? await solarHistory.remove(scope: scope)
            updateHistoryOnboarding()
        }

        /// The selected site's solar layout and home location are cleared from iCloud and on this device.
        func clearSiteLayoutInCloud() async {
            guard let accountScopeID, let selectedSiteID else { return }
            let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
            try? await solarCloudSync.deleteRecord(scope: scope)
            await historyOnboarding?.forget(scope: scope)
            coordinator?.invalidateSolarLayout()
            await historyOnboarding?.refreshStatus()
            updateHistoryOnboarding()
        }

        var siteHistoryDebugActions: SiteHistoryDebugActions? {
            guard let historyOnboarding, let accountScopeID, let selectedSiteID else { return nil }
            return SiteHistoryDebugActions(
                scope: SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID),
                reset: { [weak self] in await self?.resetSiteHistoryOnDevice() },
                clearCloudLayout: { [weak self] in await self?.clearSiteLayoutInCloud() },
                refresh: { await historyOnboarding.refreshStatus() }
            )
        }
    }

    /// The Debug section at the foot of Site History.
    struct SiteHistoryDebugSection: View {
        let actions: SiteHistoryDebugActions
        @AppStorage private var ignoresLayout: Bool
        @State private var isConfirmingReset = false
        @State private var isResetting = false
        @State private var isConfirmingCloudClear = false
        @State private var isClearingCloud = false

        init(actions: SiteHistoryDebugActions) {
            self.actions = actions
            _ignoresLayout = AppStorage(wrappedValue: false, SiteHistoryDebugSettings.ignoresLayoutKey(actions.scope))
        }

        var body: some View {
            Section {
                Toggle("Ignore Existing Layout", isOn: $ignoresLayout)
                    .onChange(of: ignoresLayout) { Task { await actions.refresh() } }
                resetHistoryButton
                clearCloudButton
            } header: {
                Text("Debug")
            } footer: {
                Text("Debug builds only. Ignoring the layout makes loading search as if this were a new site.")
            }
        }

        private var resetHistoryButton: some View {
            Button("Reset History on This Device", role: .destructive) { isConfirmingReset = true }
                .disabled(isResetting || isClearingCloud)
                .confirmationDialog("Reset this site’s history on this device?",
                                    isPresented: $isConfirmingReset, titleVisibility: .visible) {
                    Button("Reset", role: .destructive) {
                        isResetting = true
                        Task {
                            await actions.reset()
                            isResetting = false
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Forgets loading progress and the history stored on this device. "
                        + "The server’s history and your solar layout stay.")
                }
        }

        private var clearCloudButton: some View {
            Button("Clear iCloud Layout & Location", role: .destructive) { isConfirmingCloudClear = true }
                .disabled(isResetting || isClearingCloud)
                .confirmationDialog("Clear solar layout and home location in iCloud?",
                                    isPresented: $isConfirmingCloudClear, titleVisibility: .visible) {
                    Button("Clear iCloud & Device State", role: .destructive) {
                        isClearingCloud = true
                        Task {
                            await actions.clearCloudLayout()
                            isClearingCloud = false
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Removes your saved home location and detected solar layout from iCloud and this device. "
                        + "Onboarding will ask for your location again.")
                }
        }
    }
#endif
