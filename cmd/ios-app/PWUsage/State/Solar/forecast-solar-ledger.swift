import Foundation

struct ForecastSolarLedgerState: Codable, Equatable, Sendable {
    /// Start times of every request sent in the last hour, failures included.
    var requests: [Date] = []
    var deferredUntil: Date?
}

enum ForecastSolarReservation: Equatable, Sendable {
    case granted
    case deferred(until: Date)
    case exhausted
    /// The reservation could not be saved, so nothing may be sent.
    case storageFailed
}

/// The device-wide Forecast.Solar request budget: every site and account on this phone shares
/// it, and it survives relaunch and sign-out. Reservations are saved before anything is sent.
actor ForecastSolarRequestLedger {
    static let shared = ForecastSolarRequestLedger(file: ProtectedSolarForecastFile(name: "forecast-solar-ledger.json"))
    static let requestsPerHour = 6
    static let window: TimeInterval = 60 * 60

    private let file: any SolarForecastFileStoring<ForecastSolarLedgerState>
    private let clock: any SolarForecastClock
    private var state = ForecastSolarLedgerState()
    private var loaded = false

    init(
        file: any SolarForecastFileStoring<ForecastSolarLedgerState>,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.file = file
        self.clock = clock
    }

    /// Reserves `count` requests at once, or none.
    func reserve(_ count: Int) async -> ForecastSolarReservation {
        guard await loadIfNeeded() else { return .storageFailed }
        let now = clock.now()
        if let until = state.deferredUntil, until > now { return .deferred(until: until) }
        state.requests.removeAll { now.timeIntervalSince($0) >= Self.window || $0 > now }
        guard count > 0, state.requests.count + count <= Self.requestsPerHour else { return .exhausted }
        // Committed before the save suspends, so a concurrent reservation sees it.
        state.requests += Array(repeating: now, count: count)
        do {
            try await file.save(state)
        } catch {
            for _ in 0 ..< count {
                if let index = state.requests.lastIndex(of: now) { state.requests.remove(at: index) }
            }
            return .storageFailed
        }
        return .granted
    }

    /// Never shortens an existing deferral.
    func recordDeferral(until date: Date) async {
        _ = await loadIfNeeded()
        state.deferredUntil = max(state.deferredUntil ?? date, date)
        try? await file.save(state)
    }

    /// A ledger that cannot be read refuses to send, rather than assume an empty budget.
    private func loadIfNeeded() async -> Bool {
        guard !loaded else { return true }
        do {
            let saved = try await file.load()
            // Another call may have loaded and changed the state while this one waited.
            if !loaded, let saved { state = saved }
            loaded = true
            return true
        } catch {
            return false
        }
    }
}
