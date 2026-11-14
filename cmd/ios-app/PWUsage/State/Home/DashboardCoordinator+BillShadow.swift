import Foundation

extension DashboardCoordinator {
    func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            if await tryPerformLocalBill(siteID: siteID, generation: generation) {
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
            } else if billPricingMode == .local,
                      let accountScopeID {
                let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
                await syncFlowsIfNeeded(
                    scope: scope,
                    site: response.site,
                    cycle: DateInterval(start: response.currentBill.cycleStart, end: response.currentBill.cycleEnd),
                    expectedThrough: response.sources.energyDataThrough,
                    generation: generation
                )
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
            cycle: DateInterval(start: server.currentBill.cycleStart, end: server.currentBill.cycleEnd),
            expectedThrough: server.sources.energyDataThrough,
            generation: generation
        )
        guard server.tariffReattribution?.status != .running else { return }
        guard case .ready(let localResponse) = await buildLocalBill(
            scope: scope, site: server.site, generation: generation
        ) else { return }
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
        guard localResponse.tariffReattribution?.status != .running,
              Self.snapshotsMatch(server: server, local: localResponse) else { return }
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

    private func tryPerformLocalBill(siteID: String, generation: Int) async -> Bool {
        guard billPricingMode == .local,
              let accountScopeID,
              let cachedSite = bill.response?.site else { return false }
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: siteID)
        await refreshLocalFlows(scope: scope, site: cachedSite, generation: generation)
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return true }
        guard case .ready(let localResponse) = await buildLocalBill(
            scope: scope, site: cachedSite, generation: generation
        ) else { return false }
        guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return true }
        publishBillResponse(localResponse)
        return true
    }

    private func refreshLocalFlows(
        scope: SolarForecastSiteScope,
        site: MobileBillResponse.Site,
        generation: Int
    ) async {
        guard generation == siteGeneration,
              canRequestAccountData,
              let solarAPI = api as? any MobileSolarHistoryDataAPI,
              let siteZone = TimeZone(identifier: site.timezone) else { return }
        let currentNow = now()
        let cycle = BillingCycle.current(billingDay: billingDay, now: currentNow, timeZone: siteZone)
        let cycleStartDay = SolarHistoryStore.dayString(cycle.start, timeZone: siteZone)
        _ = try? await history.syncFlows(
            scope: scope,
            api: solarAPI,
            cycleStartDay: cycleStartDay,
            now: currentNow
        )
    }

    private func syncFlowsIfNeeded(
        scope: SolarForecastSiteScope,
        site: MobileBillResponse.Site,
        cycle: DateInterval,
        expectedThrough: Date?,
        generation: Int
    ) async {
        guard flowSyncTask == nil,
              let solarAPI = api as? any MobileSolarHistoryDataAPI,
              let siteZone = TimeZone(identifier: site.timezone) else { return }
        let flowDays = try? await history.flowDays(scope: scope, from: cycle.start, to: cycle.end)
        let oldestMissing = try? await history.oldestDayMissingFlows(scope: scope)
        let localThrough = flowDays.flatMap {
            LocalBillBuilder.lastNonNilSlotInstant(in: $0, cycleStart: cycle.start, cycleEnd: cycle.end)
        }
        let isBehindServer = if let expectedThrough {
            localThrough.map { $0 < expectedThrough } ?? true
        } else {
            false
        }
        let needsSync = flowDays == nil || flowDays?.isEmpty == true || oldestMissing != nil || isBehindServer
        guard needsSync else { return }
        let cycleStartDay = SolarHistoryStore.dayString(cycle.start, timeZone: siteZone)
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

    private static func snapshotsMatch(server: MobileBillResponse, local: MobileBillResponse) -> Bool {
        guard let serverThrough = server.sources.energyDataThrough else { return true }
        return local.sources.energyDataThrough == serverThrough
    }

    private func clearFlowSyncTask() {
        flowSyncTask = nil
    }
}
