import Foundation
import SwiftUI

/// Debug-build controls on Site History, for watching a real import from scratch. Created only
/// in Debug builds; Release never shows them.
struct SiteHistoryDebugActions {
    let scope: SolarForecastSiteScope
    /// Forgets this site's onboarding progress and on-device history, then starts again.
    let reset: @MainActor () async -> Void
    /// Rereads the status after a setting changes.
    let refresh: @MainActor () async -> Void
    /// Owes the reveal again for the stored layout.
    let replayReveal: @MainActor () async -> Void
}

#if DEBUG
    /// Per-site Debug settings, kept in the standard defaults.
    enum SiteHistoryDebugSettings {
        /// Treat layouts from before this was turned on as absent, so onboarding runs the full
        /// search and can show what it finds. The stored layout is untouched (clearing it would sync
        /// the change through iCloud). The key holds when it was turned on.
        static func ignoresLayoutKey(_ scope: SolarForecastSiteScope) -> String {
            "debug.siteHistory.ignoresLayoutSince.\(scope.accountScopeID)|\(scope.siteID)"
        }

        static func ignoresLayout(_ scope: SolarForecastSiteScope, defaults: UserDefaults = .standard) -> Bool {
            defaults.double(forKey: ignoresLayoutKey(scope)) > 0
        }

        static func setIgnoresLayout(
            _ ignores: Bool, scope: SolarForecastSiteScope, at date: Date = .now,
            defaults: UserDefaults = .standard
        ) {
            if ignores {
                defaults.set(date.timeIntervalSince1970, forKey: ignoresLayoutKey(scope))
            } else {
                defaults.removeObject(forKey: ignoresLayoutKey(scope))
            }
        }

        /// Whether a result detected at `detectedAt` predates the setting being turned on.
        static func hidesResult(
            detectedAt: Date?, scope: SolarForecastSiteScope, defaults: UserDefaults = .standard
        ) -> Bool {
            guard ignoresLayout(scope, defaults: defaults) else { return false }
            let since = defaults.double(forKey: ignoresLayoutKey(scope))
            return (detectedAt?.timeIntervalSince1970 ?? 0) < since
        }
    }

    extension PWUsageAppModel {
        /// The selected site's onboarding progress and on-device solar history are forgotten;
        /// the server's history, the layout record and other sites are untouched.
        func resetSiteHistoryOnDevice() async {
            guard let historyOnboarding, let accountScopeID, let selectedSiteID else { return }
            let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
            // A rerun hides what the last run found too, so it searches from nothing again.
            if SiteHistoryDebugSettings.ignoresLayout(scope) {
                SiteHistoryDebugSettings.setIgnoresLayout(true, scope: scope)
            }
            await historyOnboarding.forget(scope: scope)
            try? await solarHistory.remove(scope: scope)
            updateHistoryOnboarding()
        }

        var siteHistoryDebugActions: SiteHistoryDebugActions? {
            guard let historyOnboarding, let accountScopeID, let selectedSiteID else { return nil }
            return SiteHistoryDebugActions(
                scope: SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID),
                reset: { [weak self] in await self?.resetSiteHistoryOnDevice() },
                refresh: { await historyOnboarding.refreshStatus() },
                replayReveal: { [weak self] in
                    try? await self?.solarRunner?.records.markRevealOwed(
                        scope: SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID))
                    await historyOnboarding.refreshStatus()
                }
            )
        }
    }

    /// The Debug section at the foot of Site History.
    struct SiteHistoryDebugSection: View {
        let actions: SiteHistoryDebugActions
        /// When Ignore Existing Layout was turned on, or 0.
        @AppStorage private var ignoredSince: Double
        @State private var isConfirmingReset = false
        @State private var isResetting = false

        init(actions: SiteHistoryDebugActions) {
            self.actions = actions
            _ignoredSince = AppStorage(wrappedValue: 0, SiteHistoryDebugSettings.ignoresLayoutKey(actions.scope))
        }

        var body: some View {
            Section {
                Toggle("Ignore Existing Layout", isOn: Binding(
                    get: { ignoredSince > 0 },
                    set: { ignoredSince = $0 ? Date.now.timeIntervalSince1970 : 0 }
                ))
                .onChange(of: ignoredSince) { Task { await actions.refresh() } }
                Button("Replay Reveal") { Task { await actions.replayReveal() } }
                Button("Reset History on This Device", role: .destructive) { isConfirmingReset = true }
                    .disabled(isResetting)
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
            } header: {
                Text("Debug")
            } footer: {
                Text("Debug builds only. Ignoring the layout makes loading search as if this were a new site, until it "
                    + "finds one. Replay Reveal plays the reveal here, or owes it to the banner if you leave first.")
            }
        }
    }
#endif
