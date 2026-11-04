import Combine
import Foundation

extension DashboardCoordinator {
    /// The automatic forecast's view of this site, for Smart Shift's "Copy diagnostics".
    func solarForecastDiagnostics() async -> SmartShiftDiagnostics.SolarForecast? {
        guard accountScopeID != nil else { return nil }
        let publication = solarForecastPublication
        var diagnostics = SmartShiftDiagnostics.SolarForecast(
            publication: publication, now: now(),
            recommendationUsable: publication != nil,
            lastErrorDescription: nil,
            lastRefresh: solarForecastAttempt?.outcome,
            unavailableCause: solarForecastUnavailableCause,
            connection: forecastConnectionForConsumers, state: solarForecastState,
            unavailableReason: solarForecastUnavailableReason
        )
        diagnostics.automaticProviderID = solarForecastAttempt?.providerID?.rawValue
        diagnostics.automaticRefreshOutcome = solarForecastAttempt.map { "\($0.outcome)" }
        diagnostics.automaticDiagnostic = solarForecastAttempt?.diagnostic
        diagnostics.source = publication.map { SmartShiftForecastSource(publication: $0, now: now()) }
        return diagnostics
    }

    func refreshSolarForecast(manual: Bool) async {
        guard canRequestAccountData else { return }
        let operation = beginForecastOperation()
        forecastOperationPending = true
        defer { if operation == forecastGeneration { forecastOperationPending = false } }
        guard accountScopeID != nil else {
            solarForecastState = .basic
            return
        }
        let siteID = selectedSiteID
        let status = await solarLayoutLookup(siteID: siteID, operation: operation)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        if runner != nil, status != .disabled {
            guard let planningAPI else {
                clearAutomaticPublication()
                return
            }
            await loadAutomaticForecast(
                siteID: siteID, api: planningAPI, operation: operation, status: status, manual: manual)
            return
        }
        clearAutomaticPublication()
    }

    /// Settings text edits and profile comparisons are deliberately local.
    func solarForecastSettingsDidEdit() {}
    func loadProfileDidEdit() {}

    func beginForecastOperation() -> Int {
        forecastOperationPending = false
        forecastGeneration += 1
        return forecastGeneration
    }

    func resetForecastEnhancement(state: SolarForecastEnhancementState, connection: SolarForecastConnectionState) {
        loadPlanningContext = nil
        solarForecastState = state
        solarForecastConnection = connection
        solarForecastUnavailableCause = nil
        solarForecastUnavailableReason = nil
        solarForecastSaveFailure = false
        solarForecastSource = nil
        solarForecastPublication = nil
        solarForecastAttempt = nil
    }
}
