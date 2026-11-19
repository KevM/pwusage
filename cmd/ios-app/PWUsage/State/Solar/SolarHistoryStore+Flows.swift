import Foundation

enum FlowSyncProgress: Equatable, Sendable {
    case currentCycleReady
    case complete
    case partial(oldestMissing: String)
}

private struct FlowPageRequest {
    let scope: SolarForecastSiteScope
    let api: any MobileSolarHistoryDataAPI
    let startingFrom: String
    let stopAtOrAfter: String?
    let now: Date?
    let changedSince: Date?
    let token: SolarHistorySyncToken
}

private enum FlowPagesOutcome {
    case disabled
    case completed(maxFetchedAt: Date?)
}

struct EnergyFlowDay: Equatable, Sendable {
    let day: String
    let dayStart: Date
    let solarWh: [Float?]
    let loadWh: [Float?]
    let gridWh: [Float?]
    let batteryWh: [Float?]
    let batterySoc: [Float?]
}

extension SolarHistoryStore {
    /// Energy flows for every stored day in `[startDate, endDate]`, or `nil` when any day in range
    /// lacks one of the four flow series. Gaps inside `batterySoc` are normal and never mark a day unready.
    func flowDays(scope: SolarForecastSiteScope, from startDate: Date, to endDate: Date) throws -> [EnergyFlowDay]? {
        let state = try load(scope)
        let daysInRange = state.days
            .filter { $0.dayStart >= startDate && $0.dayStart <= endDate }
            .sorted { $0.dayStart < $1.dayStart }
        guard !daysInRange.isEmpty else { return [] }
        guard let zone = state.timeZone.flatMap(TimeZone.init(identifier:)) else { return nil }
        var result: [EnergyFlowDay] = []
        result.reserveCapacity(daysInRange.count)
        for stored in daysInRange {
            guard let load = stored.load,
                  let grid = stored.grid,
                  let battery = stored.battery,
                  let soc = stored.soc else {
                return nil
            }
            result.append(EnergyFlowDay(
                day: Self.dayString(stored.dayStart, timeZone: zone),
                dayStart: stored.dayStart,
                solarWh: stored.slots,
                loadWh: load,
                gridWh: grid,
                batteryWh: battery,
                batterySoc: soc
            ))
        }
        return result
    }

    /// Oldest stored site-local day lacking any of the four flow series, or `nil` when all are ready.
    func oldestDayMissingFlows(scope: SolarForecastSiteScope) throws -> String? {
        let state = try load(scope)
        guard let zone = state.timeZone.flatMap(TimeZone.init(identifier:)),
              let oldest = state.days
                  .filter({ $0.load == nil || $0.grid == nil || $0.battery == nil || $0.soc == nil })
                  .min(by: { $0.dayStart < $1.dayStart }) else {
            return nil
        }
        return Self.dayString(oldest.dayStart, timeZone: zone)
    }

    /// Backfills energy flow series via `GET /api/mobile/solar-history`: current billing cycle
    /// first, then forward from the oldest stored day still missing flows. Once a full read has
    /// covered the cycle, later reads ask only for days changed since the flow watermark.
    func syncFlows(
        scope: SolarForecastSiteScope,
        api: any MobileSolarHistoryDataAPI,
        cycleStartDay: String,
        now: Date = .now
    ) async throws -> FlowSyncProgress {
        let token = try await acquireSync(scope: scope)
        defer { endSync(scope: scope) }

        var state = try load(scope)
        let changedSince = Self.flowChangedSince(state, cycleStartDay: cycleStartDay)
        let currentCycleRequest = FlowPageRequest(
            scope: scope,
            api: api,
            startingFrom: cycleStartDay,
            stopAtOrAfter: nil,
            now: now,
            changedSince: changedSince,
            token: token
        )
        guard case .completed(let maxFetchedAt) = try await fetchFlowPages(currentCycleRequest, state: &state) else {
            return .complete
        }
        // Only `[cycleStartDay, …)` is known synced through the new watermark: an incremental read
        // skips any days before it, so a cycle start that later moves back must read in full.
        let watermark = maxFetchedAt.map { $0.addingTimeInterval(-300) }
        let syncedThrough = [state.flowsSyncedThrough, watermark].compactMap(\.self).max()
        if state.flowsSyncedFrom != cycleStartDay || state.flowsSyncedThrough != syncedThrough {
            state.flowsSyncedFrom = cycleStartDay
            state.flowsSyncedThrough = syncedThrough
            try save(state, scope: scope)
        }

        guard let oldestMissing = try oldestDayMissingFlows(scope: scope) else {
            return .complete
        }
        guard oldestMissing < cycleStartDay else {
            return .partial(oldestMissing: oldestMissing)
        }

        let backfillRequest = FlowPageRequest(
            scope: scope,
            api: api,
            startingFrom: oldestMissing,
            stopAtOrAfter: cycleStartDay,
            now: nil,
            changedSince: nil,
            token: token
        )
        guard case .completed = try await fetchFlowPages(backfillRequest, state: &state) else {
            return .complete
        }

        if let remainingMissing = try oldestDayMissingFlows(scope: scope) {
            return .partial(oldestMissing: remainingMissing)
        }
        return .complete
    }

    /// The watermark a current-cycle read may resume from: only when an earlier full read began at
    /// or before this cycle's start, so a billing day moved earlier still reads the whole cycle.
    /// `fetchedAt` is when the Tesla read started, so the watermark already trails it by five minutes.
    private static func flowChangedSince(_ state: SolarHistoryPersisted, cycleStartDay: String) -> Date? {
        guard let syncedFrom = state.flowsSyncedFrom, syncedFrom <= cycleStartDay else { return nil }
        return state.flowsSyncedThrough
    }

    private func fetchFlowPages(
        _ request: FlowPageRequest,
        state: inout SolarHistoryPersisted
    ) async throws -> FlowPagesOutcome {
        var pageFrom = request.startingFrom
        var maxFetchedAt: Date?
        while true {
            try Task.checkCancellation()
            let response = try await request.api.fetchSolarHistory(
                siteID: request.scope.siteID,
                from: pageFrom,
                changedSince: request.changedSince
            )
            try validateGeneration(
                request.token.generation,
                scope: request.scope,
                scopeGeneration: request.token.scopeGeneration
            )
            guard case .enabled(let siteZone, let days, let nextFrom) = response else {
                return .disabled
            }
            state.isEnabled = true
            state.timeZone = siteZone.identifier
            maxFetchedAt = store(days: days, in: &state, maximumFetchedAt: maxFetchedAt)
            applyLateDays(scope: request.scope, to: &state)
            try save(state, scope: request.scope)
            // `save` clears the flags only on its cached copy: clear ours so the next page writes
            // just the years it changes.
            state.dirtyYears.removeAll()
            guard let nextFrom else { break }
            if let stopAtOrAfter = request.stopAtOrAfter, nextFrom >= stopAtOrAfter { break }
            if let now = request.now, nextFrom > Self.dayString(now, timeZone: siteZone) { break }
            pageFrom = nextFrom
        }
        return .completed(maxFetchedAt: maxFetchedAt)
    }

    static func makeStoredDay(from day: MobileSolarHistoryDay) -> SolarHistoryStoredDay {
        SolarHistoryStoredDay(
            dayStart: day.dayStart,
            slots: day.solarWh.map { $0.map(Float.init) },
            load: day.loadWh.map { $0.map(Float.init) },
            grid: day.gridWh.map { $0.map(Float.init) },
            battery: day.batteryWh.map { $0.map(Float.init) },
            soc: day.batterySoc.map { $0.map(Float.init) }
        )
    }

    static func localDay(daysBefore days: Int, now: Date, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: -days, to: today)
            ?? date(daysBefore: days, now: now, timeZone: timeZone)
    }

    static func utcBootstrapDate(now: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let today = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: -366, to: today) ?? today
    }

    /// Page-one days in `[from, exactStart)` in site-local dates: the up to two days the UTC bootstrap
    /// reads before the site's 365-day boundary.
    static func droppingBoundaryDays(
        _ days: [MobileSolarHistoryDay],
        from: String,
        before exactStart: String,
        timeZone: TimeZone
    ) -> [MobileSolarHistoryDay] {
        guard from < exactStart else { return days }
        return days.filter {
            let day = dayString($0.dayStart, timeZone: timeZone)
            return day < from || day >= exactStart
        }
    }

    static func dayString(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 1970, components.month ?? 1, components.day ?? 1)
    }

    /// Serializes `sync` and `syncFlows` per scope so overlapping callers (bill refresh, solar
    /// actuals, history onboarding) wait their turn instead of cancelling each other's fetches.
    /// `remove(scope:)` and `removeAll()` still invalidate waiting and active syncs via generation.
    func acquireSync(scope: SolarForecastSiteScope) async throws -> SolarHistorySyncToken {
        let initialGeneration = generation
        let initialScopeGeneration = scopeGenerations[scope, default: 0]
        do {
            while activeSyncs[scope, default: 0] > 0 {
                try Task.checkCancellation()
                try await waitForSyncTurn(scope: scope)
                try validateGeneration(initialGeneration, scope: scope, scopeGeneration: initialScopeGeneration)
            }
            try Task.checkCancellation()
            try validateGeneration(initialGeneration, scope: scope, scopeGeneration: initialScopeGeneration)
        } catch {
            wakeNextSyncWaiterIfIdle(scope: scope)
            throw error
        }
        activeSyncs[scope, default: 0] += 1
        return SolarHistorySyncToken(generation: initialGeneration, scopeGeneration: initialScopeGeneration)
    }

    private func waitForSyncTurn(scope: SolarForecastSiteScope) async throws {
        let waiterID = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                self.enqueueSyncWaiter(scope: scope, id: waiterID, continuation: continuation)
            }
        } onCancel: {
            Task { await self.cancelSyncWaiter(scope: scope, id: waiterID) }
        }
    }

    private func enqueueSyncWaiter(
        scope: SolarForecastSiteScope,
        id: UUID,
        continuation: CheckedContinuation<Void, any Error>
    ) {
        if Task.isCancelled {
            continuation.resume(throwing: CancellationError())
            return
        }
        if activeSyncs[scope, default: 0] == 0 {
            continuation.resume()
            return
        }
        syncWaiters[scope, default: []].append(SyncWaiter(id: id, continuation: continuation))
    }

    func endSync(scope: SolarForecastSiteScope) {
        activeSyncs[scope, default: 1] -= 1
        guard activeSyncs[scope] == 0 else { return }
        activeSyncs.removeValue(forKey: scope)
        lateDays.removeValue(forKey: scope)
        wakeNextSyncWaiterIfIdle(scope: scope)
    }

    private func wakeNextSyncWaiterIfIdle(scope: SolarForecastSiteScope) {
        guard activeSyncs[scope, default: 0] == 0,
              var waiters = syncWaiters[scope], !waiters.isEmpty else { return }
        let next = waiters.removeFirst()
        if waiters.isEmpty {
            syncWaiters.removeValue(forKey: scope)
        } else {
            syncWaiters[scope] = waiters
        }
        next.continuation.resume()
    }

    func cancelAllSyncWaiters(scope: SolarForecastSiteScope) {
        guard let waiters = syncWaiters.removeValue(forKey: scope) else { return }
        for waiter in waiters {
            waiter.continuation.resume(throwing: CancellationError())
        }
    }

    func cancelAllSyncWaiters() {
        let allWaiters = syncWaiters
        syncWaiters.removeAll()
        for waiters in allWaiters.values {
            for waiter in waiters {
                waiter.continuation.resume(throwing: CancellationError())
            }
        }
    }

    private func cancelSyncWaiter(scope: SolarForecastSiteScope, id: UUID) {
        guard var waiters = syncWaiters[scope],
              let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        if waiters.isEmpty {
            syncWaiters.removeValue(forKey: scope)
        } else {
            syncWaiters[scope] = waiters
        }
        waiter.continuation.resume(throwing: CancellationError())
    }

    private static func date(daysBefore days: Int, now: Date, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(byAdding: .day, value: -days, to: now) ?? now.addingTimeInterval(Double(-days) * 86_400)
    }
}
