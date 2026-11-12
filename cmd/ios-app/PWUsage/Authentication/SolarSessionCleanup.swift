import Foundation

@MainActor
protocol SolarForecastSessionCleanup: Sendable {
    func signOut() async throws
}

@MainActor
struct SolarSessionCleanup: SolarForecastSessionCleanup {
    var service: (any SolarForecastServing)?
    var historyStore: SolarHistoryStore = .shared
    var layoutRecordStore: SolarLayoutRecordStore = .shared
    var cloudSync: SolarLayoutCloudSync = .shared
    var onboardingStore: SiteHistoryOnboardingStore = .shared
    var deepHistoryStore: SiteDeepHistoryStore = .shared
    var dayLedgerStore: SiteHistoryDayLedgerStore = .shared
    var additionalCleanup: (@Sendable () async throws -> Void)?

    /// Runs behind the synchronization actor's cleanup barrier, so a replacement session
    /// cannot attach or write until every account file is gone. Every step runs even if
    /// an earlier one fails; a failure leaves the store closed until this is retried.
    func signOut() async throws {
        try await cloudSync.endSession { try await clearLocalData() }
    }

    private func clearLocalData() async throws {
        var firstError: (any Error)?
        do { try await service?.clearAccountData() } catch { firstError = error }
        do { try await historyStore.removeAll() } catch { firstError = firstError ?? error }
        do { try await layoutRecordStore.removeAll() } catch { firstError = firstError ?? error }
        do { try await onboardingStore.removeAll() } catch { firstError = firstError ?? error }
        do { try await deepHistoryStore.removeAll() } catch { firstError = firstError ?? error }
        do { try await dayLedgerStore.removeAll() } catch { firstError = firstError ?? error }
        if let additionalCleanup {
            do { try await additionalCleanup() } catch { firstError = firstError ?? error }
        }
        if let firstError { throw firstError }
    }
}
