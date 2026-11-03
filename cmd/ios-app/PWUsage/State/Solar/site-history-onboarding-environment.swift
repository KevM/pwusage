import Foundation

/// The app's onboarding environment: the server fill, the on-device history and layout records,
/// and the layout runner for checkpoint detections.
@MainActor
final class LiveSiteHistoryOnboardingEnvironment: SiteHistoryOnboardingEnvironment {
    private let api: any MobileSolarHistoryFillAPI
    private let history: SolarHistoryStore
    private let records: SolarLayoutRecordStore
    private let runner: SolarLayoutDetectionRunner

    init(
        api: any MobileSolarHistoryFillAPI, history: SolarHistoryStore, records: SolarLayoutRecordStore,
        runner: SolarLayoutDetectionRunner
    ) {
        self.api = api
        self.history = history
        self.records = records
        self.runner = runner
    }

    func fill(siteID: String, from: String, days: Int) async throws -> MobileSolarHistoryFillResponse {
        try await api.fillSolarHistory(siteID: siteID, from: from, days: days)
    }

    func storeDays(_ fill: MobileSolarHistoryFill, scope: SolarForecastSiteScope) async throws {
        try await history.merge(fill, scope: scope)
    }

    /// The stored zone, or one learned by the ordinary history sync (shared with the runner's).
    func siteTimeZone(scope: SolarForecastSiteScope) async -> TimeZone? {
        if let zone = try? await history.timeZone(scope: scope) { return zone }
        guard case .synced(let zone) = await runner.syncHistory(scope: scope) else { return nil }
        return zone
    }

    /// The persisted beta flag, or the answer of a first history sync when there is none yet.
    func isHistoryEnabled(scope: SolarForecastSiteScope) async -> Bool {
        if let enabled = try? await history.isEnabled(scope: scope) { return enabled }
        guard case .synced = await runner.syncHistory(scope: scope) else { return false }
        return true
    }

    func hasLocation(scope: SolarForecastSiteScope) async -> Bool {
        await record(scope)?.location != nil
    }

    func hasUsableLayout(scope: SolarForecastSiteScope) async -> Bool {
        #if DEBUG
            if SiteHistoryDebugSettings.ignoresLayout(scope) { return false }
        #endif
        guard let result = await record(scope)?.result else { return false }
        return SolarLayoutDetector.forecastLayout(result, detectedAt: .distantPast) != nil
    }

    func readiness(scope: SolarForecastSiteScope) async -> SolarLayoutReadiness? {
        guard let location = await record(scope)?.location,
              let zone = try? await history.timeZone(scope: scope),
              let samples = try? await history.samples(scope: scope) else { return nil }
        return await Task.detached(priority: .utility) {
            SolarLayoutDetector.readiness(
                samples: samples, latitude: location.latitude, longitude: location.longitude, timeZone: zone)
        }.value
    }

    func detect(scope: SolarForecastSiteScope) async -> DetectedSolarLayout? {
        await runner.runIfDue(scope: scope, force: true)?.result
    }

    private func record(_ scope: SolarForecastSiteScope) async -> SolarLayoutRecord? {
        try? await records.record(scope: scope)
    }
}
