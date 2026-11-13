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
    /// Runs one background opportunity's work now, in the foreground, and schedules the next.
    let runBackgroundPass: @MainActor () async -> Void
    /// Runs the solar health pass on the site's stored history and returns a summary.
    let runHealthPass: @MainActor () async -> String
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
                },
                runBackgroundPass: { [weak self] in
                    let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
                    // As iOS would: nothing runs in the foreground meanwhile.
                    await historyOnboarding.deactivate()
                    let next = await historyOnboarding.runInBackground(scope: scope)
                    BackgroundSiteHistoryOnboarding.schedule(earliest: next)
                    self?.updateHistoryOnboarding()
                },
                runHealthPass: { [weak self] in
                    guard let self else { return "Unavailable" }
                    let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: selectedSiteID)
                    return await runSolarHealthPassDebug(scope: scope)
                }
            )
        }

        private func runSolarHealthPassDebug(scope: SolarForecastSiteScope) async -> String {
            let started = ProcessInfo.processInfo.systemUptime
            do {
                guard let record = try await solarRunner?.records.record(scope: scope) else {
                    return "No layout record"
                }
                guard let result = try await SolarHealthPass.run(
                    scope: scope, history: solarHistory, record: record) else {
                    return "Missing location, time zone, or layout"
                }
                let elapsed = String(format: "%.1fs", ProcessInfo.processInfo.systemUptime - started)
                let summary = result.years.map { year in
                    let factor = year.capacity.map { String(format: "%.2f", $0.site) } ?? "—"
                    return "\(year.year): \(factor) (\(year.clearDays)d, \(year.shade.count)s)"
                }.joined(separator: ", ")
                return "\(result.reference.source.rawValue) in \(elapsed): \(summary)"
            } catch {
                return "Failed: \(error.localizedDescription)"
            }
        }
    }

    /// The Debug section at the foot of Site History.
    struct SiteHistoryDebugSection: View {
        let actions: SiteHistoryDebugActions
        /// When Ignore Existing Layout was turned on, or 0.
        @AppStorage private var ignoredSince: Double
        @State private var isConfirmingReset = false
        @State private var isResetting = false
        @State private var pendingBackground: Date?
        @State private var isRunningBackgroundPass = false
        @State private var isRunningHealthPass = false
        @State private var healthPassSummary: String?

        init(actions: SiteHistoryDebugActions) {
            self.actions = actions
            _ignoredSince = AppStorage(wrappedValue: 0, SiteHistoryDebugSettings.ignoresLayoutKey(actions.scope))
        }

        @ViewBuilder private var backgroundRows: some View {
            LabeledContent("Background request") {
                Text(pendingBackground.map { $0.formatted(date: .omitted, time: .standard) } ?? "None pending")
            }
            .task { pendingBackground = await BackgroundSiteHistoryOnboarding.pendingEarliest() }
            Button("Run Background Pass Now") {
                isRunningBackgroundPass = true
                Task {
                    await actions.runBackgroundPass()
                    pendingBackground = await BackgroundSiteHistoryOnboarding.pendingEarliest()
                    isRunningBackgroundPass = false
                }
            }
            .disabled(isRunningBackgroundPass)
        }

        var body: some View {
            Section {
                Toggle("Ignore Existing Layout", isOn: Binding(
                    get: { ignoredSince > 0 },
                    set: { ignoredSince = $0 ? Date.now.timeIntervalSince1970 : 0 }
                ))
                .onChange(of: ignoredSince) { Task { await actions.refresh() } }
                backgroundRows
                Button(isRunningHealthPass ? "Running Health Pass…" : "Run Health Pass") {
                    isRunningHealthPass = true
                    Task {
                        healthPassSummary = await actions.runHealthPass()
                        isRunningHealthPass = false
                    }
                }
                .disabled(isRunningHealthPass)
                if let healthPassSummary {
                    Text(healthPassSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
