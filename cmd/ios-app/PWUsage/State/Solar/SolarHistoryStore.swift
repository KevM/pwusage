import CryptoKit
import Foundation

enum SolarHistorySyncResult: Equatable, Sendable { case disabled, synced(timeZone: TimeZone) }

actor SolarHistoryStore {
    static let shared = SolarHistoryStore()
    /// How many days back `hourlyActuals` reads.
    static let actualsDays = 14
    private typealias StoredDay = SolarHistoryStoredDay
    private typealias Persisted = SolarHistoryPersisted

    private enum PageResult { case disabled, completed(timeZone: TimeZone, maxFetchedAt: Date?) }

    private struct PageSyncContext {
        let scope: SolarForecastSiteScope
        let api: any MobileSolarHistoryDataAPI
        let now: Date
        let startingFrom: String
        let generation: Int
        let scopeGeneration: Int
    }

    private let directory: URL
    private let fileManager: FileManager
    private var cache: [SolarForecastSiteScope: Persisted] = [:]
    private var generation = 0
    private var scopeGenerations: [SolarForecastSiteScope: Int] = [:]
    /// Syncs running per scope, and days merged while one ran: a sync saves the state it loaded
    /// before its pages, so it reapplies these first.
    private var activeSyncs: [SolarForecastSiteScope: Int] = [:]
    private var lateDays: [SolarForecastSiteScope: [MobileSolarHistoryDay]] = [:]

    init(fileManager: FileManager = .default, directory customDirectory: URL? = nil) {
        self.fileManager = fileManager
        directory = customDirectory ?? (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory).appendingPathComponent("SolarHistory", isDirectory: true)
    }

    func sync(
        scope: SolarForecastSiteScope,
        api: any MobileSolarHistoryDataAPI,
        now: Date = .now
    ) async throws -> SolarHistorySyncResult {
        scopeGenerations[scope, default: 0] += 1
        activeSyncs[scope, default: 0] += 1
        defer {
            activeSyncs[scope, default: 1] -= 1
            if activeSyncs[scope] == 0 {
                activeSyncs.removeValue(forKey: scope)
                lateDays.removeValue(forKey: scope)
            }
        }
        let syncGeneration = generation
        let scopeGeneration = scopeGenerations[scope, default: 0]
        var state = try load(scope)
        let zone = TimeZone(identifier: state.timeZone ?? "UTC") ?? .gmt
        // The endpoint returns the site zone only with page one. Bootstrap in UTC, then restart
        // the first sync at the exact site-local boundary when those dates differ.
        let scanStart: Date
        if state.syncedThrough == nil {
            scanStart = state.timeZone == nil
                ? Self.utcBootstrapDate(now: now)
                : Self.localDay(daysBefore: 365, now: now, timeZone: zone)
        } else {
            scanStart = Self.localDay(daysBefore: 400, now: now, timeZone: zone)
        }
        let from = Self.dayString(scanStart, timeZone: zone)
        let pageContext = PageSyncContext(
            scope: scope, api: api, now: now, startingFrom: from,
            generation: syncGeneration, scopeGeneration: scopeGeneration)
        let pageResult = try await fetchPages(pageContext, state: &state)
        try validateGeneration(syncGeneration, scope: scope, scopeGeneration: scopeGeneration)
        guard case .completed(let timeZone, let maxFetchedAt) = pageResult else {
            state.isEnabled = false
            state.syncedAt = now
            state.days.removeAll()
            state.syncedThrough = nil
            state.timeZone = nil
            try save(state, scope: scope)
            return .disabled
        }
        state.isEnabled = true
        state.timeZone = timeZone.identifier
        if let maxFetchedAt { state.syncedThrough = maxFetchedAt.addingTimeInterval(-300) }
        state.syncedAt = now
        _ = store(days: lateDays[scope] ?? [], in: &state, maximumFetchedAt: nil)
        try validateGeneration(syncGeneration, scope: scope, scopeGeneration: scopeGeneration)
        try save(state, scope: scope)
        return .synced(timeZone: timeZone)
    }

    /// Keep the days a history fill returned. The sync watermark does not move, so the next sync
    /// still reads every day changed since it.
    func merge(_ fill: MobileSolarHistoryFill, scope: SolarForecastSiteScope) throws {
        var state = try load(scope)
        state.timeZone = state.timeZone ?? fill.timeZone.identifier
        state.isEnabled = true
        _ = store(days: fill.days, in: &state, maximumFetchedAt: nil)
        try save(state, scope: scope)
        if activeSyncs[scope] != nil { lateDays[scope, default: []].append(contentsOf: fill.days) }
    }

    private func fetchPages(_ context: PageSyncContext, state: inout Persisted) async throws -> PageResult {
        let watermark = state.syncedThrough
        var pageFrom = context.startingFrom
        var maxFetchedAt: Date?
        var checkedLocalStart = state.timeZone != nil
        var resultZone: TimeZone?
        var canRetryBoundary = watermark != nil
        syncPages: while true {
            try Task.checkCancellation()
            let response: MobileSolarHistoryResponse
            do {
                response = try await context.api.fetchSolarHistory(
                    siteID: context.scope.siteID, from: pageFrom, changedSince: watermark)
            } catch PWUsageAPIError.requestRejected(statusCode: 400, message: _) where canRetryBoundary {
                try validateGeneration(
                    context.generation, scope: context.scope, scopeGeneration: context.scopeGeneration)
                canRetryBoundary = false
                let zone = state.timeZone.flatMap(TimeZone.init(identifier:)) ?? .gmt
                pageFrom = Self.dayString(Self.localDay(daysBefore: 399, now: context.now, timeZone: zone),
                                          timeZone: zone)
                continue syncPages
            }
            canRetryBoundary = false
            try validateGeneration(
                context.generation, scope: context.scope, scopeGeneration: context.scopeGeneration)
            switch response {
            case .disabled:
                return .disabled
            case .enabled(let siteZone, let days, let nextFrom):
                resultZone = siteZone
                if !checkedLocalStart {
                    checkedLocalStart = true
                    let exactStart = Self.dayString(
                        Self.localDay(daysBefore: 365, now: context.now, timeZone: siteZone), timeZone: siteZone)
                    if pageFrom != exactStart {
                        state.days.removeAll()
                        maxFetchedAt = nil
                        pageFrom = exactStart
                        continue syncPages
                    }
                }
                maxFetchedAt = store(days: days, in: &state, maximumFetchedAt: maxFetchedAt)
                if let nextFrom { pageFrom = nextFrom } else { break syncPages }
            }
        }
        return .completed(timeZone: resultZone ?? .gmt, maxFetchedAt: maxFetchedAt)
    }

    private func store(
        days: [MobileSolarHistoryDay],
        in state: inout Persisted,
        maximumFetchedAt: Date?
    ) -> Date? {
        var latestFetchedAt = maximumFetchedAt
        for day in days {
            if let fetchedAt = day.fetchedAt {
                latestFetchedAt = max(latestFetchedAt ?? fetchedAt, fetchedAt)
            }
            let storedDay = StoredDay(dayStart: day.dayStart, slots: day.solarWh.map { $0.map(Float.init) })
            state.days.removeAll { $0.dayStart == day.dayStart }
            state.days.append(storedDay)
            state.dirtyYears.insert(SolarHistoryYearFiles.year(of: day.dayStart))
        }
        return latestFetchedAt
    }

    /// Days older than this are kept but not read by detection or the day strip.
    static let detectionWindowDays = 400

    /// The recent window layout detection and the day strip read: the days the store held before
    /// it kept the whole history. `allSamples` reads everything.
    func samples(scope: SolarForecastSiteScope, now: Date = .now) throws -> [(timestamp: Date, solarWh: Double)] {
        try Self.samples(of: windowedDays(try load(scope), now: now))
    }

    /// Every stored day, for work that looks across years.
    func allSamples(scope: SolarForecastSiteScope) throws -> [(timestamp: Date, solarWh: Double)] {
        try Self.samples(of: load(scope).days)
    }

    private static func samples(of days: [StoredDay]) -> [(timestamp: Date, solarWh: Double)] {
        days.flatMap { day in
            day.slots.enumerated().compactMap { index, value in
                guard let value, value.isFinite, value >= 0 else { return nil }
                return (timestamp: day.dayStart.addingTimeInterval(Double(index * 300)), solarWh: Double(value))
            }
        }
    }

    private func windowedDays(_ state: Persisted, now: Date) -> [StoredDay] {
        let zone = state.timeZone.flatMap(TimeZone.init(identifier:)) ?? .gmt
        let start = Self.localDay(daysBefore: Self.detectionWindowDays, now: now, timeZone: zone)
        return state.days.filter { $0.dayStart >= start }
    }

    /// Site-local days holding any reading in the recent window, oldest first.
    func storedDays(scope: SolarForecastSiteScope, now: Date = .now) throws -> [String] {
        let state = try load(scope)
        return Self.readingDays(windowedDays(state, now: now), timeZone: state.timeZone)
    }

    /// Site-local days holding any reading, across the whole history, oldest first.
    func allStoredDays(scope: SolarForecastSiteScope) throws -> [String] {
        let state = try load(scope)
        return Self.readingDays(state.days, timeZone: state.timeZone)
    }

    private static func readingDays(_ days: [StoredDay], timeZone identifier: String?) -> [String] {
        guard let zone = identifier.flatMap(TimeZone.init(identifier:)) else { return [] }
        return days
            .filter { $0.slots.contains { $0.map { $0.isFinite && $0 >= 0 } ?? false } }
            .map { dayString($0.dayStart, timeZone: zone) }
            .sorted()
    }

    func lastDay(scope: SolarForecastSiteScope) throws -> String? {
        let state = try load(scope)
        guard let dayStart = state.days.map(\.dayStart).max(),
              let zone = state.timeZone.flatMap(TimeZone.init(identifier:)) else { return nil }
        return Self.dayString(dayStart, timeZone: zone)
    }

    func timeZone(scope: SolarForecastSiteScope) throws -> TimeZone? {
        guard let identifier = try load(scope).timeZone else { return nil }
        return TimeZone(identifier: identifier)
    }

    func isSynced(scope: SolarForecastSiteScope, within interval: TimeInterval, now: Date) throws -> Bool {
        let state = try load(scope)
        guard let timestamp = state.syncedAt ?? state.syncedThrough else { return false }
        return now.timeIntervalSince(timestamp) < interval
    }

    func isEnabled(scope: SolarForecastSiteScope) throws -> Bool? {
        try load(scope).isEnabled
    }

    func hourlyActuals(scope: SolarForecastSiteScope, now: Date = .now) throws -> [MobileSolarActualsHour] {
        let state = try load(scope)
        guard let identifier = state.timeZone, let zone = TimeZone(identifier: identifier) else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let today = calendar.startOfDay(for: now)
        guard let start = calendar.date(byAdding: .day, value: -Self.actualsDays, to: today) else { return [] }
        var slotsByTime: [Date: [Float?]] = [:]
        // Only the recent days can hold a slot in range; the rest of a long history is skipped.
        for day in state.days where day.dayStart >= start.addingTimeInterval(-86_400) {
            for (index, value) in day.slots.enumerated() {
                let timestamp = day.dayStart.addingTimeInterval(Double(index * 300))
                slotsByTime[timestamp, default: []].append(value)
            }
        }
        var buckets: [Date: (values: [Date: Double], invalid: Bool)] = [:]
        for (timestamp, candidates) in slotsByTime where timestamp >= start && timestamp <= now {
            let hour = Date(timeIntervalSince1970: floor(timestamp.timeIntervalSince1970 / 3600) * 3600)
            var bucket = buckets[hour] ?? ([:], false)
            guard timestamp.timeIntervalSince1970.truncatingRemainder(dividingBy: 300) == 0,
                  candidates.count == 1, let value = candidates[0], value.isFinite, value >= 0 else {
                bucket.invalid = true
                buckets[hour] = bucket
                continue
            }
            bucket.values[timestamp] = Double(value)
            buckets[hour] = bucket
        }
        return buckets.keys.sorted().map { hour in
            let bucket = buckets[hour] ?? ([:], true)
            let energy = bucket.values.values.reduce(0, +)
            return MobileSolarActualsHour(hourStart: hour, energyWh: (energy * 10).rounded() / 10,
                                          complete: !bucket.invalid && bucket.values.count == 12)
        }
    }

    func remove(scope: SolarForecastSiteScope) throws {
        scopeGenerations[scope, default: 0] += 1
        cache.removeValue(forKey: scope)
        let url = fileURL(scope)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        let days = daysDirectory(scope)
        if fileManager.fileExists(atPath: days.path) { try fileManager.removeItem(at: days) }
    }

    func removeAll() throws {
        generation += 1
        scopeGenerations.removeAll()
        cache.removeAll()
        if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
    }

    private func load(_ scope: SolarForecastSiteScope) throws -> Persisted {
        if let state = cache[scope] { return state }
        let url = fileURL(scope)
        guard fileManager.fileExists(atPath: url.path) else { return Persisted() }
        var state = try JSONDecoder().decode(Persisted.self, from: Data(contentsOf: url))
        if state.days.isEmpty {
            state.days = try loadYears(scope)
        } else {
            // Written before per-year files: every year moves to its own file on the next save.
            state.dirtyYears = Set(state.days.map { SolarHistoryYearFiles.year(of: $0.dayStart) })
        }
        cache[scope] = state
        return state
    }

    private func loadYears(_ scope: SolarForecastSiteScope) throws -> [StoredDay] {
        try yearFiles(scope).load()
    }

    private func yearFiles(_ scope: SolarForecastSiteScope) -> SolarHistoryYearFiles {
        SolarHistoryYearFiles(fileManager: fileManager, folder: daysDirectory(scope))
    }

    private func save(_ state: Persisted, scope: SolarForecastSiteScope) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(directoryValues)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        // Year files first: a store still in the older format keeps its days in the state file
        // until that file is replaced, so an interrupted save only repeats the move.
        try yearFiles(scope).save(state)
        try JSONEncoder().encode(state).write(
            to: fileURL(scope),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        var saved = state
        saved.dirtyYears = []
        cache[scope] = saved
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL(scope).path
        )
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var protectedFile = fileURL(scope)
        try protectedFile.setResourceValues(fileValues)
    }

    private func validateGeneration(
        _ expected: Int,
        scope: SolarForecastSiteScope,
        scopeGeneration expectedScopeGeneration: Int
    ) throws {
        guard generation == expected, scopeGenerations[scope] == expectedScopeGeneration else {
            throw CancellationError()
        }
    }

    private func fileURL(_ scope: SolarForecastSiteScope) -> URL {
        directory.appendingPathComponent("\(scopeHash(scope)).json")
    }

    /// A site's per-year day files, inside the store's directory so removing the directory removes them.
    private func daysDirectory(_ scope: SolarForecastSiteScope) -> URL {
        directory.appendingPathComponent("\(scopeHash(scope))-days", isDirectory: true)
    }

    private func scopeHash(_ scope: SolarForecastSiteScope) -> String {
        let key = "\(scope.accountScopeID)|\(scope.siteID)"
        return SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func date(daysBefore days: Int, now: Date, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(byAdding: .day, value: -days, to: now) ?? now.addingTimeInterval(Double(-days) * 86_400)
    }

    private static func localDay(daysBefore days: Int, now: Date, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: -days, to: today)
            ?? date(daysBefore: days, now: now, timeZone: timeZone)
    }

    private static func utcBootstrapDate(now: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let today = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: -364, to: today) ?? today
    }

    private static func dayString(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 1970, components.month ?? 1, components.day ?? 1)
    }
}
