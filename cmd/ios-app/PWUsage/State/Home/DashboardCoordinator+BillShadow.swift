import Foundation

extension DashboardCoordinator {
    func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            if billPricingMode == .local,
               let scope = accountScopeID.map({ SolarForecastSiteScope(accountScopeID: $0, siteID: siteID) }),
               let cachedSite = bill.response?.site,
               case .ready(let localResponse) = await buildLocalBill(
                   scope: scope, site: cachedSite, generation: generation
               ) {
                guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
                publishBillResponse(localResponse)
                return
            }
            let response: MobileBillResponse
            if let conditionalAPI = api as? any MobileConditionalDashboardDataAPI {
                response = try await conditionalAPI.fetchBill(siteID: siteID, reusing: bill.response)
            } else {
                response = try await api.fetchBill(siteID: siteID)
            }
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
            publishBillResponse(response)
            if billPricingMode == .shadow {
                await evaluateBillShadow(server: response, siteID: siteID, generation: generation)
            }
        } catch {
            guard !isAbandonedRequest() else { return }
            guard generation == siteGeneration else { return }
            recordAttempt(.bill)
            handle(error, generation: generation, endpoint: .bill)
        }
    }

    private func publishBillResponse(_ response: MobileBillResponse) {
        recordAttempt(.bill)
        bill.response = response
        billSuccessGeneration += 1
        let successTime = now()
        bill.lastSuccess = successTime
        bill.isRestored = false
        cache?.storeBill(response, at: successTime)
        bill.isUnavailable = false
        bill.freshReadingWait = nil
    }

    func evaluateBillShadow(server: MobileBillResponse, siteID: String, generation: Int) async {
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
        guard let accountScopeID else { return }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        await syncFlowsIfNeeded(
            scope: scope,
            site: server.site,
            cycleStart: server.currentBill.cycleStart,
            cycleEnd: server.currentBill.cycleEnd,
            generation: generation
        )
        guard server.tariffReattribution?.status != .running else { return }
        let flowDays = try? await history.flowDays(
            scope: scope, from: server.currentBill.cycleStart, to: server.currentBill.cycleEnd
        )
        if let flowDays, flowDays.isEmpty, !server.currentBill.periods.isEmpty { return }
        guard case .ready(let localResponse) = await buildLocalBill(
            scope: scope, site: server.site, generation: generation
        ) else { return }
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
        guard localResponse.tariffReattribution?.status != .running else { return }
        guard shadowDedup.shouldReport(siteID: siteID, cycleStart: server.currentBill.cycleStart) else { return }
        guard let report = BillShadowComparison.differences(server: server, local: localResponse) else { return }
        guard let shadowAPI = api as? any MobileBillShadowAPI else { return }
        shadowDedup.markReported(siteID: siteID, cycleStart: server.currentBill.cycleStart)
        try? await shadowAPI.reportBillShadow(report)
    }

    func buildLocalBill(
        scope: SolarForecastSiteScope,
        site: MobileBillResponse.Site,
        generation: Int
    ) async -> LocalBillResult {
        var timeline: SiteTariffsTimelineResponse?
        if api is any MobileTariffDataAPI {
            timeline = try? await revalidateTariffTimeline()
        }
        if timeline == nil {
            timeline = try? await ratePlanTimelines.saved(scope: scope)?.timeline
        }
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else {
            return .notReady(.noTimeline)
        }
        let builder = LocalBillBuilder(store: history)
        return (try? await builder.build(
            site: site,
            billingDay: billingDay,
            timeline: timeline,
            scope: scope,
            now: now()
        )) ?? .notReady(.flowsMissing)
    }

    private func syncFlowsIfNeeded(
        scope: SolarForecastSiteScope,
        site: MobileBillResponse.Site,
        cycleStart: Date,
        cycleEnd: Date,
        generation: Int
    ) async {
        guard flowSyncTask == nil,
              let solarAPI = api as? any MobileSolarHistoryDataAPI,
              let siteZone = TimeZone(identifier: site.timezone) else { return }
        let flowDays = try? await history.flowDays(scope: scope, from: cycleStart, to: cycleEnd)
        let oldestMissing = try? await history.oldestDayMissingFlows(scope: scope)
        let needsSync = flowDays == nil || flowDays?.isEmpty == true || oldestMissing != nil
        guard needsSync else { return }
        let cycleStartDay = SolarHistoryStore.dayString(cycleStart, timeZone: siteZone)
        let currentNow = now()
        flowSyncTask = Task { [weak self] in
            defer {
                if let self, generation == siteGeneration {
                    clearFlowSyncTask()
                }
            }
            _ = try? await self?.history.syncFlows(
                scope: scope,
                api: solarAPI,
                cycleStartDay: cycleStartDay,
                now: currentNow
            )
        }
    }

    private func clearFlowSyncTask() {
        flowSyncTask = nil
    }
}
