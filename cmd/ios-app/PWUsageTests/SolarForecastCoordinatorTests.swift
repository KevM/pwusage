import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar Forecast Coordinator Tests", .serialized)
struct SolarForecastCoordinatorTests {
    @Test("Billing loads history without live Tesla refresh and reuses planning context")
    func billingReusesPlanningContext() async {
        let forecast = ForecastManagerSpy()
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-a", api: api, planningAPI: api,
                                               forecastStore: forecast, accountScopeID: "local-account", now: { api.now }, timerInterval: nil)
        await coordinator.billOutlookAppeared()
        await coordinator.billOutlookAppeared()
        #expect(api.billSiteIDs == ["site-a"])
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.liveSiteIDs.isEmpty)
        #expect(await forecast.refreshCount == 0)
    }

    @Test("A retained Smart Shift tab skips foreground requests while another tab is selected")
    func hiddenDetailSkipsForegroundRefresh() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(await forecast.refreshCount == 1)
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.billSiteIDs == ["site-a"])

        // Visit Home, then foreground the app after the request caches expire.
        api.now = api.now.addingTimeInterval(24 * 60 * 60)
        await coordinator.loadTimingDetailForegrounded(isSelected: false)
        #expect(await forecast.refreshCount == 1)
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.billSiteIDs == ["site-a"])
        #expect(coordinator.solarForecastState == .enhanced)

        // Foregrounding with Smart Shift selected must still refresh normally.
        await coordinator.loadTimingDetailForegrounded(isSelected: true)
        #expect(await forecast.refreshCount == 2)
        #expect(api.contextSiteIDs == ["site-a", "site-a"])
        #expect(api.billSiteIDs == ["site-a", "site-a"])
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("Unconfigured detail keeps basic estimate and performs no forecast-only requests")
    func unconfiguredDetailMakesNoForecastRequests() async {
        let forecast = ForecastManagerSpy()
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .basic)
        #expect(await forecast.refreshCount == 0)
        // The household pattern also feeds the forecast-free projection, so it
        // is read without Solcast; nothing else is.
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.billSiteIDs.isEmpty)
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("A cached household profile does not hide why the forecast is unusable")
    func cachedContextKeepsTheRealForecastReason() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .enhanced)

        // The profile is now served from the 24-hour cache; the forecast has gone stale.
        await forecast.setRecommendationUsable(false)
        await coordinator.loadTimingDetailAppeared()

        #expect(api.contextSiteIDs == ["site-a"])
        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .forecastNotUsable)
        #expect(coordinator.householdPattern != nil)
    }

    @Test("A refused refresh keeps a still-usable cached forecast pricing Smart Shift")
    func refusedRefreshKeepsUsableForecast() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .enhanced)

        // The Solcast budget is spent, but the saved forecast is still fresh.
        await forecast.setRefreshResults([.budgetExhausted, .budgetExhausted])
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)

        await coordinator.refreshSolarForecast(manual: true)
        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
    }

    @Test("Smart Shift fetches fresher energy data before the forecast comparison would pause")
    func agingEnergyDataRefreshesTheBillEarly() async {
        let clock = ForecastTestClock()
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 1)

        // Energy data through 07:55 is 21 minutes old at 08:16: well inside the 30-minute
        // bill cadence, but close to the 30 minutes the forecast comparison allows.
        clock.advance(seconds: 16 * 60)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 2)

        // Still old (the server has nothing newer), but never more than every five minutes.
        clock.advance(seconds: 2 * 60)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 2)
        clock.advance(seconds: 4 * 60)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 3)
    }

    @Test("Without Solcast, aging energy data waits for the usual bill cadence")
    func agingEnergyDataWithoutSolcastKeepsTheCadence() async {
        let clock = ForecastTestClock()
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: ForecastManagerSpy(), accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 1)

        clock.advance(seconds: 16 * 60)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Solcast's setup reads as checking until the device has looked")
    func connectionIsCheckingUntilResolved() async {
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: ForecastManagerSpy(), accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        #expect(coordinator.solarForecastConnection == .checking)
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastConnection == .notConnected)

        let noStore = DashboardCoordinator(siteID: "site-a", api: api, planningAPI: api, forecastStore: nil,
                                           accountScopeID: "local-account", now: { api.now }, timerInterval: nil)
        await noStore.loadTimingDetailAppeared()
        #expect(noStore.solarForecastConnection == .notConnected)
    }

    @Test("householdPatternLoadsWithoutSolcast")
    func householdPatternLoadsWithoutSolcast() async {
        let clock = ForecastTestClock()
        let forecast = ForecastManagerSpy()
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern != nil)
        #expect(coordinator.householdPattern?.timeZone == "UTC")
        #expect(coordinator.loadPlanningContext == nil)
        #expect(coordinator.solarForecastConnection == .notConnected)
        #expect(await forecast.refreshCount == 0)

        clock.advance(hours: 23)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(coordinator.householdPattern != nil)
    }

    @Test("The Solcast path publishes the household pattern from its one request")
    func solcastPathPublishesHouseholdPattern() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.householdPattern == coordinator.loadPlanningContext)
        #expect(api.contextSiteIDs == ["site-a"])
    }

    @Test("Configured detail progresses from basic through loading to enhanced without live polling")
    func configuredDetailProgressesToEnhanced() async throws {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        #expect(coordinator.solarForecastState == .basic)
        let request = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshStarts()
        #expect(coordinator.solarForecastState == .loadingWithBasic)
        #expect(api.liveSiteIDs.isEmpty)

        await forecast.resumeRefresh(with: .refreshed)
        await request.value

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
        #expect(coordinator.loadPlanningContext != nil)
        #expect(api.billSiteIDs == ["site-a"])
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("Refresh failure immediately restores basic and later success recovers enhancement")
    func refreshFailureFallsBackAndRecovers() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setRefreshResults([.refreshed, .failed(.requestFailed), .refreshed])
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .enhanced)
        // A failure the store treats as disabling the saved forecast (a rejected key, say).
        await forecast.setRecommendationUsable(false)
        await coordinator.refreshSolarForecast(manual: true)
        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastBatch == nil)
        await forecast.setRecommendationUsable(true)
        await coordinator.refreshSolarForecast(manual: true)
        #expect(coordinator.solarForecastState == .enhanced)
    }

    @Test("A save failure leaves the enhancement up and claims no unavailability cause")
    func saveFailureLeavesEnhancementUp() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        await forecast.setRefreshResults([.failed(.saveFailed)])

        await coordinator.refreshSolarForecast(manual: true)

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
        #expect(coordinator.solarForecastUnavailableCause == nil)
        #expect(coordinator.solarForecastSaveFailure)
    }

    @Test("A save failure on the appearance path leaves the enhancement up too")
    func appearancePathSaveFailureLeavesEnhancementUp() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        // Armed before the first appearance, so the appearance path itself is the
        // one that sees the save failure. This is the dominant path — pull to
        // refresh is the exception — and it is the one that has to agree with
        // refreshSolarForecast about what a save failure means.
        await forecast.setRefreshResults([.failed(.saveFailed)])
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
        #expect(coordinator.solarForecastUnavailableCause == nil)
        #expect(coordinator.solarForecastSaveFailure)
    }

    @Test("A later failure on the appearance path clears an earlier save-failure note")
    func appearancePathFailureAfterSaveFailureClearsTheNote() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setRefreshResults([.failed(.saveFailed), .failed(.requestFailed)])
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastSaveFailure)

        // The second failure disables the saved forecast in the store.
        await forecast.setRecommendationUsable(false)
        await coordinator.loadTimingDetailAppeared()

        // The save-failure note describes a forecast that is on screen and usable.
        // Once the enhancement has actually been torn down, leaving it set would be
        // a claim about a state that no longer exists.
        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastSaveFailure == false)
    }

    @Test("Fresh validated context is reused for twenty four hours")
    func contextIsCachedForTwentyFourHours() async {
        let clock = ForecastTestClock()
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        clock.advance(hours: 23)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.contextSiteIDs == ["site-a"])
        clock.advance(hours: 2)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.contextSiteIDs == ["site-a", "site-a"])
    }

    @Test("Context failure or mismatched site keeps the basic estimate")
    func unusableContextKeepsBasicEstimate() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextResponseSiteID = "site-b"
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.loadPlanningContext == nil)
    }

    @Test("Stale context keeps the basic estimate")
    func staleContextKeepsBasicEstimate() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextAsOf = api.now.addingTimeInterval(-25 * 60 * 60)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.loadPlanningContext == nil)
    }

    @Test("Planning context is validated at receive time and permits an hour of source clock skew")
    func contextUsesReceiveTimeForValidation() async {
        let clock = ForecastTestClock()
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy(now: clock.now)
        api.contextAsOf = clock.now.addingTimeInterval(60)
        api.beforeContextResponse = { clock.advance(seconds: 120) }
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .enhanced)
    }

    @Test("Planning context more than an hour in the future is rejected")
    func contextRejectsExcessiveFutureSkew() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextAsOf = api.now.addingTimeInterval(60 * 60 + 1)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
    }

    @Test("Planning context without five usable day votes and sufficient coverage is rejected")
    func contextRejectsInsufficientVotes() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextUsableDayCount = 4
        api.contextSampleCount = 4
        api.contextCoverage = 0.89
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
    }

    @Test("Planning context timezone must match the refreshed bill site timezone")
    func contextRejectsBillTimezoneMismatch() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextTimeZone = "America/Chicago"
        api.billTimeZone = "UTC"
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
    }

    @Test("An older failed detail operation cannot overwrite a newer successful enhancement")
    func latestDetailOperationWins() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        let older = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshCount(1)
        let newer = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshCount(2)

        await forecast.resumeRefresh(at: 1, with: .refreshed)
        await newer.value
        #expect(coordinator.solarForecastState == .enhanced)
        await forecast.resumeRefresh(at: 0, with: .failed(.requestFailed))
        await older.value

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastBatch != nil)
    }

    @Test("Simultaneous detail appearances share one planning context request")
    func simultaneousDetailsDeduplicateContext() async throws {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.holdContextResponses = true
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        let first = Task { await coordinator.loadTimingDetailAppeared() }
        let second = Task { await coordinator.loadTimingDetailAppeared() }
        try await waitUntil { !api.contextSiteIDs.isEmpty }
        for _ in 0 ..< 20 { await Task.yield() }

        #expect(api.contextSiteIDs.count == 1)
        api.resumeContextResponses()
        await first.value
        await second.value
    }

    @Test("A failed shared planning context request is removed so a later detail can retry")
    func failedContextCanRetry() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextError = PWUsageAPIError.invalidResponse
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastState == .failedWithBasic)
        api.contextError = nil
        // Past the bill floor, so this appearance's bill refresh really runs and
        // the enhancement is judged on fresh data.
        api.now = api.now.addingTimeInterval(6 * 60)
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(api.contextSiteIDs == ["site-a", "site-a"])
    }

    @Test("Enhancement requires the bill refresh to succeed instead of retaining an older response")
    func failedBillRefreshCannotEnhanceFromRetainedBill() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.refreshBill(trigger: .userGesture)
        #expect(coordinator.bill.response != nil)
        api.billError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        // Past the appearance floor, so the appearance really does attempt the
        // bill and has to refuse the enhancement on a failed refresh rather than
        // on a merely stale one.
        api.now = api.now.addingTimeInterval(6 * 60)

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastBatch == nil)
    }

    @Test("Disconnect cleanup failure keeps the connection and exposes retry instead of claiming success")
    func disconnectCleanupFailureIsSurfaced() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setDisconnectError(.cleanupFailed)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        let result: Void? = try? await coordinator.disconnectSolarForecast()

        #expect(result == nil)
        #expect(coordinator.solarForecastState != .disconnectedBasic)
        #expect(await coordinator.solarForecastCredential() != nil)
    }

    @Test("Authentication invalidation rejects a late forecast completion")
    func logoutRejectsLateRefresh() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        let request = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshStarts()

        coordinator.authenticationInvalidated()
        await forecast.resumeRefresh(with: .refreshed)
        await request.value

        #expect(coordinator.solarForecastState == .basic)
        #expect(coordinator.solarForecastBatch == nil)
        #expect(coordinator.loadPlanningContext == nil)
    }

    @Test("Disconnect during refresh prevents a late completion from restoring enhancement")
    func disconnectRejectsLateRefresh() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        let request = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshStarts()

        try? await coordinator.disconnectSolarForecast()
        await forecast.resumeRefresh(with: .refreshed)
        await request.value

        #expect(coordinator.solarForecastState == .disconnectedBasic)
        #expect(coordinator.solarForecastBatch == nil)
        #expect(coordinator.loadPlanningContext == nil)
    }

    @Test("Site switch rejects old completions and uses the new site's configuration")
    func siteSwitchRejectsOldCompletion() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        let request = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshStarts()

        coordinator.selectSite("site-b")
        await forecast.resumeRefresh(with: .refreshed)
        await request.value

        #expect(coordinator.selectedSiteID == "site-b")
        #expect(coordinator.solarForecastState == .basic)
        #expect(coordinator.solarForecastBatch == nil)
    }

    @Test("An HTTP failure is reported as a request failure, not as a missing profile")
    func httpFailureIsNotReportedAsAMissingProfile() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextError = PWUsageAPIError.recoverableServerError(statusCode: 500)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .requestFailed,
                "A rejected request must never be reported as a profile we could not read")
    }

    @Test("A contract rejection is reported distinctly from a missing profile")
    func contractRejectionIsReportedDistinctly() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextError = MobileLoadPlanningContextResponse.ContractError.invalidSource
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .contextMalformed)
    }

    /// A clock the server and device disagree about is the one failure the person
    /// holding the phone can fix, so it is the only one allowed to become advice
    /// about their date and time. Everything else would keep failing unchanged.
    @Test("Only a skewed clock is reported as fixable on this device")
    func onlyClockSkewIsReportedAsContextInvalid() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextError = MobileLoadPlanningContextResponse.ContractError.timestampSkew
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastUnavailableReason == .contextInvalid)

        api.contextError = MobileLoadPlanningContextResponse.ContractError.invalidSource
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastUnavailableReason == .contextMalformed,
                "A payload no clock change can fix must not be reported as a clock problem")

        api.contextError = MobileLoadPlanningContextResponse.ContractError.siteMismatch(expected: "site-a", actual: "site-b")
        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.solarForecastUnavailableReason == .contextMalformed,
                "A site mismatch is not something the device clock can repair")
    }

    @Test("A missing route is reported as a server that is out of date")
    func missingRouteIsReportedAsAnOutdatedServer() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextError = PWUsageAPIError.requestRejected(statusCode: 404, message: nil)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .serverOutdated,
                "A 404 means the server predates this route, not that data is missing")
    }

    @Test("A misaligned history is distinguished from a short one")
    func misalignedHistoryIsReportedDistinctly() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextIsUnavailable = true
        api.contextUnavailableReason = "timestamp-misaligned"
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .timestampMisaligned)
    }

    @Test("A short history is reported as such rather than as a generic gap")
    func shortHistoryIsReportedDistinctly() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextIsUnavailable = true
        api.contextUnavailableReason = "insufficient-history"
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .insufficientHistory)
    }

    @Test("A missing planning context is distinguished from an unusable forecast")
    func missingContextIsReportedDistinctly() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        api.contextIsUnavailable = true
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .contextUnavailable)
    }

    @Test("An unusable forecast cache is distinguished from a missing context")
    func unusableForecastIsReportedDistinctly() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setRecommendationUsable(false)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .failedWithBasic)
        #expect(coordinator.solarForecastUnavailableReason == .forecastNotUsable)
    }

    @Test("An enhanced load has no unavailable reason")
    func enhancedLoadHasNoUnavailableReason() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastUnavailableReason == nil)
    }

    @Test("A manual forecast refresh runs when the detail view is pulled to refresh")
    func pullToRefreshAlsoRefreshesTheForecast() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        await coordinator.loadTimingDetailAppeared()
        let before = await forecast.refreshCount

        await coordinator.loadTimingDetailRefreshed()

        #expect(await forecast.refreshCount > before,
                "Pull to refresh must actually refresh the forecast, or the note lies")
    }

    @Test("Site switch re-runs the detail load for the newly selected site")
    func siteSwitchStartsEnhancementForNewSite() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a", alsoConfigured: ["site-b"])
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()
        let beforeSwitch = await forecast.refreshCount

        coordinator.selectSite("site-b")
        let retried = await forecast.reachedRefreshCount(beforeSwitch + 1)

        #expect(coordinator.selectedSiteID == "site-b")
        #expect(retried, "Switching sites must re-run the forecast detail load for the new site")
    }

    @Test("Profile comparisons and settings edits perform no requests")
    func localEditsPerformNoRequests() async throws {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )
        let before = await forecast.totalNetworkOperations

        coordinator.solarForecastSettingsDidEdit()
        coordinator.loadProfileDidEdit()

        #expect(await forecast.totalNetworkOperations == before)
        #expect(api.contextSiteIDs.isEmpty)
        #expect(api.billSiteIDs.isEmpty)
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("Unsaved settings edits do not strand a loading enhancement")
    func settingsEditDoesNotInvalidateLoading() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldRefresh(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        let request = Task { await coordinator.loadTimingDetailAppeared() }
        await forecast.waitUntilRefreshStarts()
        coordinator.solarForecastSettingsDidEdit()
        await forecast.resumeRefresh(with: .refreshed)
        await request.value

        #expect(coordinator.solarForecastState == .enhanced)
    }

    @Test("Unsaved settings edits do not supersede a disconnect in progress")
    func settingsEditDoesNotInvalidateDisconnect() async {
        let forecast = ForecastManagerSpy(configuredSiteID: "site-a")
        await forecast.setHoldDisconnect(true)
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            forecastStore: forecast, accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        let disconnect = Task { try? await coordinator.disconnectSolarForecast() }
        await forecast.waitUntilDisconnectStarts()
        coordinator.solarForecastSettingsDidEdit()
        await forecast.resumeDisconnect()
        await disconnect.value

        #expect(coordinator.solarForecastState == .disconnectedBasic)
    }
}

private final class ForecastTestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    func advance(hours: Double) { now = now.addingTimeInterval(hours * 3_600) }
    func advance(seconds: Double) { now = now.addingTimeInterval(seconds) }
}

private actor ForecastManagerSpy: SolarForecastManaging {
    private var configuredSiteIDs: Set<String>
    private var results: [SolarForecastRefreshResult] = [.refreshed]
    private var holdRefresh = false
    private var refreshContinuations: [Int: CheckedContinuation<SolarForecastRefreshResult, Never>] = [:]
    private var refreshCountWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var disconnectError: SolarForecastStore.StoreError?
    private var holdDisconnect = false
    private var disconnectStarted = false
    private var disconnectStartWaiter: CheckedContinuation<Void, Never>?
    private var disconnectContinuation: CheckedContinuation<Void, Never>?
    private var recommendationUsable = true
    private(set) var refreshCount = 0
    private(set) var discoveryCount = 0
    private(set) var connectCount = 0

    init(configuredSiteID: String? = nil, alsoConfigured siteIDs: Set<String> = []) {
        self.configuredSiteIDs = Set(siteIDs).union(configuredSiteID.map { [$0] } ?? [])
    }

    var totalNetworkOperations: Int { refreshCount + discoveryCount }
    func setRefreshResults(_ values: [SolarForecastRefreshResult]) { results = values }
    func setHoldRefresh(_ value: Bool) { holdRefresh = value }
    func waitUntilRefreshStarts() async {
        await waitUntilRefreshCount(1)
    }
    func waitUntilRefreshCount(_ expected: Int) async {
        if refreshCount >= expected { return }
        await withCheckedContinuation { refreshCountWaiters.append((expected, $0)) }
    }
    /// Bounded wait so a missing behaviour fails the test instead of hanging it.
    func reachedRefreshCount(_ target: Int, withinMilliseconds budget: Int = 2000) async -> Bool {
        for _ in 0 ..< budget {
            if refreshCount >= target { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return refreshCount >= target
    }
    func resumeRefresh(with result: SolarForecastRefreshResult) {
        resumeRefresh(at: refreshContinuations.keys.min() ?? 0, with: result)
    }
    func resumeRefresh(at index: Int, with result: SolarForecastRefreshResult) {
        refreshContinuations.removeValue(forKey: index)?.resume(returning: result)
    }
    func setDisconnectError(_ error: SolarForecastStore.StoreError?) { disconnectError = error }
    func setRecommendationUsable(_ value: Bool) { recommendationUsable = value }
    func setHoldDisconnect(_ value: Bool) { holdDisconnect = value }
    func waitUntilDisconnectStarts() async {
        if disconnectStarted { return }
        await withCheckedContinuation { disconnectStartWaiter = $0 }
    }
    func resumeDisconnect() { disconnectContinuation?.resume(); disconnectContinuation = nil }

    func activateAccountScope(_ accountScopeID: String?) {}
    func credential(accountScopeID: String, siteID: String) -> SolarForecastCredential? {
        guard configuredSiteIDs.contains(siteID) else { return nil }
        return SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID, credentialID: "fixture", resourceIDs: ["east"])
    }
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?) throws -> String {
        connectCount += 1
        configuredSiteIDs.insert(siteID)
        return "fixture"
    }
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) throws -> [SolcastSite] {
        discoveryCount += 1
        return []
    }
    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) throws {}
    func refresh(accountScopeID: String, siteID: String, manual: Bool) async -> SolarForecastRefreshResult {
        let index = refreshCount
        refreshCount += 1
        let ready = refreshCountWaiters.filter { refreshCount >= $0.0 }
        refreshCountWaiters.removeAll { refreshCount >= $0.0 }
        ready.forEach { $0.1.resume() }
        if holdRefresh {
            return await withCheckedContinuation { refreshContinuations[index] = $0 }
        }
        return results.isEmpty ? .refreshed : results.removeFirst()
    }
    func cachedBatch(accountScopeID: String, siteID: String) -> SolarForecastBatch? {
        guard configuredSiteIDs.contains(siteID) else { return nil }
        return SolarForecastBatch(
            credentialID: "fixture", resourceIDs: ["east"],
            intervals: [SolarForecastInterval(
                periodStart: Date(timeIntervalSince1970: 1_800_000_000),
                periodEnd: Date(timeIntervalSince1970: 1_800_001_800), powerKw: 2
            )], fetchedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }
    func isRecommendationUsable(accountScopeID: String, siteID: String) -> Bool { recommendationUsable }
    func budget(for accountScopeID: String, siteID: String) -> SolarForecastBudget {
        SolarForecastBudget(utcDay: Date(timeIntervalSince1970: 1_800_000_000), totalAttempts: 1, automaticAttempts: 1, deferredUntil: nil)
    }
    func signOut() async throws {}
    func disconnect(accountScopeID: String, siteID: String) async throws {
        disconnectStarted = true
        disconnectStartWaiter?.resume()
        disconnectStartWaiter = nil
        if holdDisconnect { await withCheckedContinuation { disconnectContinuation = $0 } }
        if let disconnectError { throw disconnectError }
        configuredSiteIDs.removeAll()
        let pending = Array(refreshContinuations.values)
        refreshContinuations.removeAll()
        pending.forEach { $0.resume(returning: .cancelled) }
    }
}

private extension MobileLoadPlanningContextResponse {
    static func fixture(
        siteID: String,
        timeZone: String = "UTC",
        asOf: Date,
        usableDayCount: Int = 14,
        sampleCount: Int = 14,
        coverage: Double = 1,
        availability: MobileLoadPlanningContextResponse.Availability = .available,
        unavailableReason: String? = nil
    ) -> Self {
        Self(
            version: 1,
            site: Site(id: siteID, timezone: timeZone),
            units: Units(power: "kW", localMinute: "minute-of-day"),
            asOf: asOf,
            availability: availability,
            unavailableReason: unavailableReason,
            usableDayCount: usableDayCount,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0 ..< 48).map {
                Slot(localMinute: $0 * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: sampleCount, coverage: coverage)
            }
        )
    }
}

@MainActor
private final class ForecastDashboardAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI {
    var liveSiteIDs: [String] = []
    var billSiteIDs: [String] = []
    var contextSiteIDs: [String] = []
    var contextResponseSiteID = "site-a"
    var contextTimeZone = "UTC"
    var billTimeZone = "UTC"
    var energyDataThrough = "2027-01-15T07:55:00Z"
    var now: Date
    var contextAsOf: Date?
    var contextUsableDayCount = 14
    var contextSampleCount = 14
    var contextCoverage = 1.0
    var contextIsUnavailable = false
    var contextUnavailableReason: String?
    var beforeContextResponse: (() -> Void)?
    var holdContextResponses = false
    var billError: Error?
    var contextError: Error?
    private var contextContinuations: [CheckedContinuation<Void, Never>] = []

    init(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) { self.now = now }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        if let billError { throw billError }
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"\#(billTimeZone)"},"currentBill":{"estimatedCost":1,"currency":"USD","cycleStart":"2026-01-01T00:00:00Z","cycleEnd":"2030-01-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2027-01-15T08:00:00Z","energyDataThrough":"\#(energyDataThrough)"}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        contextSiteIDs.append(siteID)
        if holdContextResponses { await withCheckedContinuation { contextContinuations.append($0) } }
        if let contextError { throw contextError }
        beforeContextResponse?()
        return MobileLoadPlanningContextResponse.fixture(
            siteID: contextResponseSiteID,
            timeZone: contextTimeZone,
            asOf: contextAsOf ?? now,
            usableDayCount: contextIsUnavailable ? 2 : contextUsableDayCount,
            sampleCount: contextSampleCount,
            coverage: contextCoverage,
            availability: contextIsUnavailable ? .unavailable : .available,
            unavailableReason: contextUnavailableReason
        )
    }

    func resumeContextResponses() {
        holdContextResponses = false
        let pending = contextContinuations
        contextContinuations.removeAll()
        pending.forEach { $0.resume() }
    }
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0 ..< 100 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Timed out waiting for coordinator test condition")
}
