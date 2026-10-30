import Combine
import Foundation

extension DashboardCoordinator {
    /// Handles the retained Smart Shift tab's foreground callback.
    func loadTimingDetailForegrounded(isSelected: Bool) async {
        guard isSelected else { return }
        await loadTimingDetailAppeared()
    }

    /// Billing needs a measured snapshot even when solar forecasting is not configured.
    /// The shared planning path reuses context and solar caches without fetching live Tesla data.
    func billOutlookAppeared() async {
        await refreshBill(trigger: .screenAppearance)
        await loadTimingDetailAppeared()
    }

    /// Starts the optional enhancement only when a local credential and array
    /// selection exist, or, for beta sites without Solcast, an automatic forecast.
    /// This path refreshes bill/context data but never live data.
    func loadTimingDetailAppeared() async {
        guard canRequestAccountData else { return }
        let operation = beginForecastOperation()
        solarSurfaceVisible = true
        guard let forecastStore, let planningAPI, let accountScopeID else {
            solarForecastState = .basic
            solarForecastConnection = .notConnected
            return
        }
        let siteID = selectedSiteID
        let credential = await forecastStore.credential(accountScopeID: accountScopeID, siteID: siteID)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        guard let credential, !credential.resourceIDs.isEmpty else {
            // A published automatic forecast keeps pricing the card while it is refreshed.
            let keepsAutomatic = credential == nil && solarForecastPublication != nil
            solarForecastState = keepsAutomatic ? .loadingWithBasic : .basic
            solarForecastConnection = credential == nil ? .notConnected : .awaitingArraySelection
            solarForecastUnavailableCause = nil
            solarForecastBatch = nil
            if !keepsAutomatic { loadPlanningContext = nil }
            if credential == nil {
                await loadForecastWithoutCredential(siteID: siteID, api: planningAPI, operation: operation)
            } else {
                solarForecastSource = nil
                solarForecastPublication = nil
                async let status: Void = refreshSolarLayoutStatus(siteID: siteID, operation: operation)
                await loadHouseholdPattern(siteID: siteID, api: planningAPI, operation: operation)
                await status
            }
            return
        }
        guard canRequestAccountData else { return }
        solarForecastState = .loadingWithBasic
        solarForecastConnection = .ready
        solarForecastUnavailableCause = nil
        solarForecastPublication = nil
        async let status: Void = refreshSolarLayoutStatus(siteID: siteID, operation: operation)
        await loadSolcastEnhancement(
            store: forecastStore, planningAPI: planningAPI, accountScopeID: accountScopeID,
            siteID: siteID, operation: operation
        )
        await status
    }

    /// The Solcast half of `loadTimingDetailAppeared`, unchanged apart from beta correction.
    private func loadSolcastEnhancement(
        store forecastStore: any SolarForecastManaging,
        planningAPI: any MobileLoadPlanningDataAPI,
        accountScopeID: String,
        siteID: String,
        operation: Int
    ) async {
        let billSuccessBeforeRefresh = billSuccessGeneration
        async let billRefresh: Void = refreshBill(trigger: .screenAppearance)
        async let refreshResult = forecastStore.refresh(accountScopeID: accountScopeID, siteID: siteID, manual: false)
        async let contextResult = planningContext(siteID: siteID, api: planningAPI)
        let (refresh, outcome) = await (refreshResult, contextResult)
        let context = outcome.context
        await billRefresh
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        solarForecastLastRefresh = refresh
        // Published even when the forecast half fails, so the card can fall back to history.
        householdPattern = context
        solarForecastUnavailableCause = SolarForecastUnavailableCause(refresh)
        // A save failure is not an unavailable forecast, on this path exactly as
        // on `refreshSolarForecast`. The batch is fresh and in memory — the store
        // kept it deliberately — so tearing the enhancement down here would show
        // "The forecast was too old or incomplete to use. Pull down to refresh it"
        // after a *successful* fetch of a brand-new forecast, which is the symptom
        // §5.5 was filed to remove. This path is the dominant one (pull-to-refresh
        // is the exception), so the omission is the more visible half of the bug.
        let saveFailed = refresh == .failed(.saveFailed)
        // A refused or failed refresh (budget, rate limit, network) doesn't dismiss
        // a forecast the store still trusts: the store disables it only for
        // key or array problems, and it ages out after six hours.
        let usableDespiteRefresh = await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID)
        let refreshSucceeded = saveFailed || refresh == .refreshed || refresh == .alreadyFresh || usableDespiteRefresh
        // The appearance-driven bill refresh is floored, so a bill fetched
        // moments ago by an earlier appearance, a site switch, or a pull is
        // already fresh. Requiring a brand new success here would drop the
        // enhancement every time the screen is reopened inside the floor.
        // Measured at the decision point, not before the awaits, so a slow
        // planning-context fetch cannot age a stale bill back into freshness.
        let billSucceeded = billSuccessGeneration > billSuccessBeforeRefresh || billIsFresh(at: now())
        let siteMatches = bill.response?.site.id == siteID
        let timeZoneMatches = context != nil && bill.response?.site.timezone == context?.timeZone
        let forecastUsable = await forecastStore.isRecommendationUsable(accountScopeID: accountScopeID, siteID: siteID)
        let batch = await forecastStore.cachedBatch(accountScopeID: accountScopeID, siteID: siteID)
        guard refreshSucceeded, billSucceeded, siteMatches, timeZoneMatches,
              forecastUsable, let batch, let context else {
            // The server's wire reason is more specific than anything inferred
            // locally, so it takes priority when present.
            solarForecastUnavailableReason = outcome.unavailableReason
                ?? Self.enhancementUnavailableReason(
                    refreshSucceeded: refreshSucceeded,
                    billSucceeded: billSucceeded,
                    siteMatches: siteMatches,
                    timeZoneMatches: timeZoneMatches,
                    forecastUsable: forecastUsable,
                    hasBatch: batch != nil,
                    hasContext: context != nil
                )
            solarForecastBatch = nil
            loadPlanningContext = nil
            solarForecastState = .failedWithBasic
            solarForecastSaveFailure = false
            return
        }
        let published = await correctedSolcastBatch(batch, siteID: siteID, context: context)
        guard operation == forecastGeneration, siteID == selectedSiteID else { return }
        solarForecastBatch = published
        loadPlanningContext = context
        solarForecastUnavailableReason = nil
        solarForecastState = .enhanced
        solarForecastSource = .solcast
        solarForecastSaveFailure = saveFailed
    }

    /// The forecast-free path's household pattern: the same cached request the
    /// Solcast path makes, so the pattern costs at most one request a day.
    func loadHouseholdPattern(siteID: String, api: any MobileLoadPlanningDataAPI, operation: Int) async {
        let outcome = await planningContext(siteID: siteID, api: api)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        householdPattern = outcome.context
    }

    struct PlanningContextOutcome {
        let context: LoadTimingForecastEstimator.PlanningContext?
        let unavailableReason: SolarForecastEnhancementUnavailableReason?
    }

    func planningContext(
        siteID: String,
        api: any MobileLoadPlanningDataAPI
    ) async -> PlanningContextOutcome {
        let requestTime = now()
        if let cached = planningContextCache[siteID],
           requestTime.timeIntervalSince(cached.fetchedAt) >= 0,
           requestTime.timeIntervalSince(cached.fetchedAt) < Self.planningContextLifetime,
           let validated = try? cached.response.validating(siteID: siteID, now: requestTime) {
            // Only an unavailable profile has a reason; a usable cached one must not
            // mask why the forecast half failed.
            let context = validated.estimatorContext
            return PlanningContextOutcome(
                context: context,
                unavailableReason: context == nil ? Self.enhancementReason(forReason: validated.unavailableReason) : nil
            )
        }
        let pending: PlanningContextTask
        if let existing = planningContextTasks[siteID] {
            pending = existing
        } else {
            let id = UUID()
            let task = Task {
                do {
                    return PlanningContextFetchResult(
                        response: try await api.fetchLoadPlanningContext(siteID: siteID),
                        error: nil
                    )
                } catch {
                    return PlanningContextFetchResult(response: nil, error: error)
                }
            }
            pending = PlanningContextTask(id: id, task: task)
            planningContextTasks[siteID] = pending
        }
        do {
            let fetched = await pending.task.value
            let receiveTime = now()
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            guard let response = fetched.response else {
                if let error = fetched.error { throw error }
                return PlanningContextOutcome(context: nil, unavailableReason: .requestFailed)
            }
            let validated = try response.validating(siteID: siteID, now: receiveTime)
            let reason = Self.enhancementReason(forReason: validated.unavailableReason)
            guard validated.availability == .available, let context = validated.estimatorContext else {
                return PlanningContextOutcome(context: nil, unavailableReason: reason)
            }
            planningContextCache[siteID] = PlanningContextCacheEntry(response: validated, fetchedAt: receiveTime)
            return PlanningContextOutcome(context: context, unavailableReason: nil)
        } catch {
            if planningContextTasks[siteID]?.id == pending.id { planningContextTasks.removeValue(forKey: siteID) }
            // A thrown error means we never learned anything about the profile.
            // Reporting it as an unreadable profile would be a guess, and the
            // user is already frustrated by guesses.
            let reason: SolarForecastEnhancementUnavailableReason
            if let contractError = error as? MobileLoadPlanningContextResponse.ContractError {
                // Only skew is the device's fault, so only skew earns clock advice.
                // Every other contract failure would keep failing with a perfect
                // clock, and telling someone to fix their date is then a dead end.
                reason = contractError == .timestampSkew ? .contextInvalid : .contextMalformed
            } else if let rejected = error as? PWUsageAPIError,
                      case .requestRejected(let statusCode, _) = rejected, statusCode == 404 {
                reason = .serverOutdated
            } else {
                reason = .requestFailed
            }
            return PlanningContextOutcome(context: nil, unavailableReason: reason)
        }
    }

    /// Pull to refresh on the Load timing screen. This is the only place a person
    /// can ask for a new forecast, so it must genuinely do that rather than
    /// refreshing bill data alone.
    func loadTimingDetailRefreshed() async {
        guard canRequestAccountData else { return }
        invalidateSolarLayout()
        await refreshBill(trigger: .userGesture)
        if solarForecastConnection != .notConnected {
            await refreshSolarForecast(manual: true)
        } else {
            await loadTimingDetailAppeared()
        }
    }

    /// Map the server's wire reason onto our own vocabulary so the note can be
    /// specific about which half of the household profile is missing.
    static func enhancementReason(
        forReason reason: String?
    ) -> SolarForecastEnhancementUnavailableReason? {
        switch reason {
        case "insufficient-history": return .insufficientHistory
        case "timestamp-misaligned": return .timestampMisaligned
        default: return .contextUnavailable
        }
    }

    static func enhancementUnavailableReason(
        refreshSucceeded: Bool,
        billSucceeded: Bool,
        siteMatches: Bool,
        timeZoneMatches: Bool,
        forecastUsable: Bool,
        hasBatch: Bool,
        hasContext: Bool
    ) -> SolarForecastEnhancementUnavailableReason? {
        if !refreshSucceeded { return nil }
        if !billSucceeded { return .billUnavailable }
        // A missing context is checked before the timezone comparison, otherwise
        // the absent value looks like a mismatch and names the wrong cause.
        if !hasContext { return .contextUnavailable }
        if !siteMatches || !timeZoneMatches { return .siteMismatch }
        if !forecastUsable || !hasBatch { return .forecastNotUsable }
        return nil
    }
}
