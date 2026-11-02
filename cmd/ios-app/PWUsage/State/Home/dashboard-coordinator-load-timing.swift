import Combine
import Foundation

extension DashboardCoordinator {
    /// Handles the retained Smart Shift tab's foreground callback.
    func loadTimingDetailForegrounded(isSelected: Bool) async {
        guard isSelected else {
            solarSurfaceDisappeared(.smartShift)
            return
        }
        await loadTimingDetailAppeared()
    }

    /// Billing needs a measured snapshot even when solar forecasting is not configured.
    /// The shared planning path reuses context and solar caches without fetching live Tesla data.
    func billOutlookAppeared(markVisible: Bool = true) async {
        guard !Task.isCancelled else { return }
        if markVisible { solarSurfaceAppeared(.bill) }
        await refreshBill(trigger: .screenAppearance)
        guard !Task.isCancelled else { return }
        await loadTimingDetailAppeared(surface: nil)
    }

    /// This path refreshes bill/context data but never live data.
    func loadTimingDetailAppeared(manual: Bool = false, surface: SolarForecastSurface? = .smartShift) async {
        guard canRequestAccountData, !Task.isCancelled else { return }
        if let surface { solarSurfaceAppeared(surface) }
        let operation = beginForecastOperation()
        forecastOperationPending = true
        defer {
            if operation == forecastGeneration { forecastOperationPending = false }
        }
        guard let planningAPI else {
            solarForecastState = .basic
            solarForecastConnection = .notConnected
            return
        }
        let siteID = selectedSiteID
        let status = await solarLayoutLookup(siteID: siteID, operation: operation)
        guard operation == forecastGeneration, siteID == selectedSiteID, canRequestAccountData else { return }
        if runner != nil, status != .disabled {
            await loadAutomaticForecast(
                siteID: siteID, api: planningAPI, operation: operation, status: status, manual: manual)
            return
        }
        resetForecastEnhancement(state: .basic, connection: .notConnected)
        await loadHouseholdPattern(siteID: siteID, api: planningAPI, operation: operation)
    }

    /// The forecast-free path's household pattern: the same cached request the
    /// Solcast path makes, so the pattern costs at most one request a day.
    func loadHouseholdPattern(siteID: String, api: any MobileLoadPlanningDataAPI, operation: Int) async {
        async let billRefresh: Void = refreshBill(trigger: .screenAppearance)
        let outcome = await planningContext(siteID: siteID, api: api)
        await billRefresh
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
        await loadTimingDetailAppeared(manual: true, surface: nil)
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
