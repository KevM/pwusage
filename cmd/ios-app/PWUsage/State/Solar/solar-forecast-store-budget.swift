import CryptoKit
import Foundation

extension SolarForecastStore {
    func reserveRequests(_ count: Int, credentialID: String, manual: Bool) -> Bool {
        let now = clock.now()
        var budget = normalizedBudget(state.budgets[credentialID], at: now)
        guard budget.deferredUntil.map({ $0 <= now }) ?? true else { return false }
        guard budget.totalAttempts + count <= Self.totalAttemptsPerUTCDay else { return false }
        if !manual, budget.automaticAttempts + count > Self.automaticAttemptsPerUTCDay { return false }
        budget.totalAttempts += count
        if !manual { budget.automaticAttempts += count }
        state.budgets[credentialID] = budget
        return true
    }

    /// Returns the part of a reservation that never produced a response. A request
    /// that completed before the cancellation stays charged, and a reservation made
    /// on an earlier UTC day is already gone. Overcharging is the safe direction, so
    /// a failed save is only queued for retry rather than escalated.
    func refundCancelledRequests(_ count: Int, credentialID: String, manual: Bool, scope: String) async {
        guard count > 0, let stored = state.budgets[credentialID] else { return }
        var budget = normalizedBudget(stored, at: clock.now())
        guard budget.utcDay == stored.utcDay else { return }
        budget.totalAttempts = max(0, budget.totalAttempts - count)
        if !manual { budget.automaticAttempts = max(0, budget.automaticAttempts - count) }
        state.budgets[credentialID] = budget
        do { try await persist() } catch { dirtyScopes.insert(scope) }
    }

    func recordRateLimit(_ error: SolcastClientError, credentialID: String) {
        guard case let .httpStatus(statusCode, retryAfter) = error, statusCode == 429 else { return }
        let now = clock.now()
        let deferred: Date
        if let retryAfter {
            switch retryAfter {
            case let .delay(seconds): deferred = now.addingTimeInterval(max(0, seconds))
            case let .date(date): deferred = max(now, date)
            }
        } else {
            deferred = Self.utcDayStart(now).addingTimeInterval(24 * 60 * 60)
        }
        var budget = normalizedBudget(state.budgets[credentialID], at: now)
        budget.deferredUntil = deferred
        state.budgets[credentialID] = budget
    }

    func normalizedBudget(_ stored: SolarForecastBudget?, at date: Date) -> SolarForecastBudget {
        let day = Self.utcDayStart(date)
        guard let stored else { return Self.emptyBudget(at: date) }
        guard stored.utcDay != day else { return stored }
        return SolarForecastBudget(
            utcDay: day,
            totalAttempts: 0,
            automaticAttempts: 0,
            deferredUntil: stored.deferredUntil.flatMap { $0 > date ? $0 : nil }
        )
    }

    static func emptyBudget(at date: Date) -> SolarForecastBudget {
        SolarForecastBudget(utcDay: utcDayStart(date), totalAttempts: 0, automaticAttempts: 0, deferredUntil: nil)
    }

    static func utcDayStart(_ date: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.startOfDay(for: date)
    }

    static func credentialID(for key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func safeDescription(_ error: SolcastClientError) -> String {
        switch error {
        case .httpStatus(let status, _): return "Forecast service returned HTTP \(status)"
        case .transportFailure: return "Forecast network request failed"
        case .invalidResourceID, .invalidResponse, .decodingFailure: return "Forecast response could not be used"
        }
    }

    static func refreshFailure(_ error: SolcastClientError) -> SolarForecastRefreshResult {
        .failed(failureKind(error))
    }

    static func failureKind(_ error: SolcastClientError) -> SolarForecastRefreshFailure {
        if case let .httpStatus(statusCode, _) = error, statusCode == 401 || statusCode == 403 { return .unauthorized }
        if case let .httpStatus(statusCode, _) = error, statusCode == 429 { return .rateLimited }
        // A 404 here means the array is not on this account, usually a mistyped
        // Solar System ID. Reporting that as an unreachable service sends the user
        // to the wrong remedy, and the attempt is still charged either way.
        if case let .httpStatus(statusCode, _) = error, statusCode == 404 { return .unknownResource }
        return error == .decodingFailure ? .invalidForecast : .requestFailed
    }
}
