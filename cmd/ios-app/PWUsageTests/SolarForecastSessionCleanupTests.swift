import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Solar session cleanup")
struct SolarForecastSessionCleanupTests {
    @Test("Session cleanup clears service history")
    @MainActor
    func sessionCleanup() async throws {
        let clock = MutableSolarClock(SolarProviderFixture.date("2026-10-18 09:00:00"))
        let automatic = OpenMeteoHarness(
            clock: clock,
            body: SolarProviderFixture.openMeteoBody(now: clock.now())
        )
        let service = SolarForecastService(
            providers: [automatic.provider],
            history: SolarForecastHistory(file: InMemorySolarFile(), clock: clock),
            clock: clock
        )
        await service.activateAccountScope(SolarProviderFixture.scopeA.accountScopeID)
        _ = try #require(await service.publication(for: SolarProviderFixture.request(now: clock.now())))
        let cleanup = SolarSessionCleanup(service: service)
        try await cleanup.signOut()
        #expect(await automatic.provider.cachedForecast(for: SolarProviderFixture.request(now: clock.now())) == nil)
        let refused = await automatic.provider.refresh(SolarProviderFixture.request(now: clock.now(), manual: true))
        #expect(refused.outcome == .refreshed, "Cleanup keeps the device ledger, which still has room")
        #expect(await automatic.transport.requests.count == 2)
    }
}
