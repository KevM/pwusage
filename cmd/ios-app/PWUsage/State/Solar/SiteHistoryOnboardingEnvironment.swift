import Foundation

/// What loading a site's history needs from the app: the server fill, the on-device history and
/// the site's time zone. The onboarding job and the deep-history walk share it.
@MainActor
protocol SiteDeepHistoryEnvironment: AnyObject {
    func fill(siteID: String, from: String, days: Int) async throws -> MobileSolarHistoryFillResponse
    /// Keep a fill's returned days in the on-device solar history.
    func storeDays(_ fill: MobileSolarHistoryFill, scope: SolarForecastSiteScope) async throws
    /// The site's time zone, nil while history is unavailable.
    func siteTimeZone(scope: SolarForecastSiteScope) async -> TimeZone?
}

/// What the onboarding job needs from the app: the history fill plus the on-device layout.
@MainActor
protocol SiteHistoryOnboardingEnvironment: SiteDeepHistoryEnvironment {
    func hasLocation(scope: SolarForecastSiteScope) async -> Bool
    /// The confidence of the stored layout when the forecast can use it.
    func layoutConfidence(scope: SolarForecastSiteScope) async -> SolarLayoutConfidence?
    /// The clear-day pass over the stored history; nil without a location or history.
    func classifyDays(scope: SolarForecastSiteScope) async -> SolarDayClassification?
    /// What the phone holds for the site's status: the stored result, home location and days.
    func storedState(scope: SolarForecastSiteScope) async -> SiteHistoryStoredState
    /// Run detection now, outside the ordinary schedule, and keep its result.
    func detect(scope: SolarForecastSiteScope) async -> DetectedSolarLayout?
    /// The found system has been seen, or the site was forgotten.
    func acknowledgeReveal(scope: SolarForecastSiteScope) async
}

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

    /// The persisted history availability, or the answer of a first history sync when there is none yet.
    func isHistoryEnabled(scope: SolarForecastSiteScope) async -> Bool {
        if let enabled = try? await history.isEnabled(scope: scope) { return enabled }
        guard case .synced = await runner.syncHistory(scope: scope) else { return false }
        return true
    }

    func acknowledgeReveal(scope: SolarForecastSiteScope) async {
        try? await records.acknowledgeReveal(scope: scope)
    }

    func hasLocation(scope: SolarForecastSiteScope) async -> Bool {
        await record(scope)?.location != nil
    }

    func layoutConfidence(scope: SolarForecastSiteScope) async -> SolarLayoutConfidence? {
        #if DEBUG
            let detectedAt = await record(scope)?.detectedAt
            if SiteHistoryDebugSettings.hidesResult(detectedAt: detectedAt, scope: scope) { return nil }
        #endif
        guard let result = await record(scope)?.result else { return nil }
        return SolarLayoutDetector.forecastLayout(result, detectedAt: .distantPast)?.confidence
    }

    func storedState(scope: SolarForecastSiteScope) async -> SiteHistoryStoredState {
        let record = await record(scope)
        var result = record?.result
        #if DEBUG
            if SiteHistoryDebugSettings.hidesResult(detectedAt: record?.detectedAt, scope: scope) { result = nil }
        #endif
        let days = (try? await history.storedDays(scope: scope)) ?? []
        let isRevealOwed = (try? await records.isRevealOwed(scope: scope)) ?? false
        return SiteHistoryStoredState(
            result: result, location: record?.location, days: days, isRevealOwed: isRevealOwed)
    }

    /// Off the main actor; cancelling the caller cancels the pass.
    func classifyDays(scope: SolarForecastSiteScope) async -> SolarDayClassification? {
        guard let location = await record(scope)?.location,
              let zone = try? await history.timeZone(scope: scope),
              let samples = try? await history.samples(scope: scope) else { return nil }
        let operation = Task.detached(priority: .utility) {
            try SolarLayoutDetector.classifyDays(
                samples: samples, latitude: location.latitude, longitude: location.longitude, timeZone: zone,
                checkCancellation: { try Task.checkCancellation() })
        }
        return await withTaskCancellationHandler {
            try? await operation.value
        } onCancel: {
            operation.cancel()
        }
    }

    func detect(scope: SolarForecastSiteScope) async -> DetectedSolarLayout? {
        await runner.runIfDue(scope: scope, force: true)?.result
    }

    private func record(_ scope: SolarForecastSiteScope) async -> SolarLayoutRecord? {
        try? await records.record(scope: scope)
    }
}
