import Foundation

/// History is partitioned by account, site, provider and semantic configuration, so a changed
/// layout or Solcast selection starts from identity correction instead of mixing forecasts.
struct SolarForecastHistoryIdentity: Hashable, Codable, Sendable {
    let accountScopeID: String
    let siteID: String
    let providerID: SolarForecastProviderID
    let fingerprint: String
}

enum SolarForecastTrainingCohort: Sendable, CaseIterable {
    /// Fetched on the target's site-local date, before the target hour began.
    case sameDay
    /// Fetched on the site-local date before the target's.
    case dayAhead
}

/// One raw fetch, integrated to the UTC hours it fully covers.
struct SolarForecastHistoryEntry: Codable, Equatable, Sendable {
    let identity: SolarForecastHistoryIdentity
    let fetchedAt: Date
    let hours: [HourEnergy]

    struct HourEnergy: Codable, Equatable, Sendable {
        let hourStart: Date
        let energyWh: Double
    }
}

protocol SolarForecastRawHistoryRecording: Sendable {
    func record(identity: SolarForecastHistoryIdentity, intervals: [SolarForecastInterval], fetchedAt: Date) async
}

/// Raw forecasts kept for 15 days so correction can compare them with what was produced.
/// Every fetch is kept, so a later same-day update never replaces day-ahead training.
actor SolarForecastHistory: SolarForecastRawHistoryRecording {
    static let shared = SolarForecastHistory(
        file: ProtectedSolarForecastFile(name: "history.json", backgroundAccessible: true)
    )
    static let retention: TimeInterval = 15 * 24 * 60 * 60

    private let file: any SolarForecastFileStoring<[SolarForecastHistoryEntry]>
    private let clock: any SolarForecastClock
    private var entries: [SolarForecastHistoryEntry] = []
    private var loaded = false
    private var generation = 0

    init(
        file: any SolarForecastFileStoring<[SolarForecastHistoryEntry]>,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.file = file
        self.clock = clock
    }

    /// Best effort: a write failure keeps the entry in memory and never fails the caller.
    func record(identity: SolarForecastHistoryIdentity, intervals: [SolarForecastInterval], fetchedAt: Date) async {
        let started = generation
        await loadIfNeeded()
        guard started == generation else { return }
        guard !entries.contains(where: { $0.identity == identity && $0.fetchedAt == fetchedAt }) else { return }
        let hours = Self.utcHours(intervals)
        guard !hours.isEmpty else { return }
        entries.append(SolarForecastHistoryEntry(identity: identity, fetchedAt: fetchedAt, hours: hours))
        prune()
        try? await file.save(entries)
    }

    /// UTC-hour Wh in [from, to) for one configuration and cohort; hours without a matching
    /// fetch are absent, never filled from another cohort or configuration.
    func pastForecast(
        identity: SolarForecastHistoryIdentity,
        cohort: SolarForecastTrainingCohort,
        from: Date,
        to end: Date,
        siteTimeZone: TimeZone
    ) async -> [Date: Double] {
        let started = generation
        await loadIfNeeded()
        guard started == generation else { return [:] }
        prune()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = siteTimeZone
        let candidates = entries.filter { $0.identity == identity }
            .map { (entry: $0, day: calendar.startOfDay(for: $0.fetchedAt), hours: Self.hourMap($0)) }
        var result: [Date: Double] = [:]
        var hour = Self.hourFloor(from)
        if hour < from { hour.addTimeInterval(3600) }
        while hour < end {
            let targetDay = calendar.startOfDay(for: hour)
            let wantedDay = cohort == .sameDay ? targetDay : calendar.date(byAdding: .day, value: -1, to: targetDay)
            let match = candidates
                .filter {
                    $0.day == wantedDay && $0.hours[hour] != nil && (cohort == .dayAhead || $0.entry.fetchedAt <= hour)
                }
                .max { $0.entry.fetchedAt < $1.entry.fetchedAt }
            if let match { result[hour] = match.hours[hour] }
            hour.addTimeInterval(3600)
        }
        return result
    }

    func clearAccountData() async throws {
        // Invalidate callers suspended in load before they can append or save old data.
        generation += 1
        loaded = true
        entries.removeAll()
        try await file.save(entries)
    }

    private func loadIfNeeded() async {
        guard !loaded else { return }
        let started = generation
        let saved = (try? await file.load()) ?? []
        guard started == generation, !loaded else { return }
        loaded = true
        entries = saved + entries
    }

    private func prune() {
        let cutoff = clock.now().addingTimeInterval(-Self.retention)
        entries.removeAll { $0.fetchedAt < cutoff }
    }

    private static func hourMap(_ entry: SolarForecastHistoryEntry) -> [Date: Double] {
        Dictionary(entry.hours.map { ($0.hourStart, $0.energyWh) }, uniquingKeysWith: { first, _ in first })
    }

    static func hourFloor(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
    }

    /// Integrates intervals into the UTC hours they cover completely.
    static func utcHours(_ intervals: [SolarForecastInterval]) -> [SolarForecastHistoryEntry.HourEnergy] {
        guard let first = intervals.map(\.periodStart).min(),
              let last = intervals.map(\.periodEnd).max() else { return [] }
        var hours: [SolarForecastHistoryEntry.HourEnergy] = []
        var hour = hourFloor(first)
        while hour < last {
            let next = hour.addingTimeInterval(3600)
            if let energy = try? SolarForecast.energy(in: intervals, from: hour, to: next) {
                hours.append(.init(hourStart: hour, energyWh: energy * 1000))
            }
            hour = next
        }
        return hours
    }
}
