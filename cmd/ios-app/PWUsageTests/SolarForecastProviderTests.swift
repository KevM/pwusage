import Foundation
@testable import PWUsage
import Testing

@Suite("Solar forecast provider contract")
struct SolarForecastProviderTests {
    private typealias Fixture = SolarProviderFixture
    private static let now = Fixture.date("2026-10-28 09:00:00")

    enum Kind: CaseIterable, Sendable { case solcast, forecastSolar, synthetic }

    private struct Built {
        let provider: any SolarForecastProviding
        let request: SolarForecastRequest
    }

    private static func build(_ kind: Kind) async -> Built {
        let clock = MutableSolarClock(now)
        let request = Fixture.request(now: now)
        switch kind {
        case .solcast:
            let store = FakeSolcastStore()
            let credential = SolarForecastCredential(
                accountScopeID: "account-a", siteID: "site-a", credentialID: "cred-1", resourceIDs: ["r2", "r1"]
            )
            let batch = SolarForecastBatch(
                credentialID: "cred-1", resourceIDs: ["r2", "r1"],
                intervals: Fixture.intervals(from: now, hours: 72, powerKw: 1, step: 1800), fetchedAt: now
            )
            await store.configure(credential: credential, batch: batch)
            return Built(provider: SolcastForecastProvider(store: store), request: request)
        case .forecastSolar:
            let body = Fixture.forecastSolarBody(now: now)
            let harness = ForecastSolarHarness(clock: clock, body: body)
            return Built(provider: harness.provider, request: request)
        case .synthetic:
            return Built(provider: SyntheticForecastProvider(clock: clock), request: request)
        }
    }

    @Test("Every provider returns a scoped raw batch matching its configuration", arguments: Kind.allCases)
    func contract(kind: Kind) async throws {
        let built = await Self.build(kind)
        let configuration = await built.provider.configuration(for: built.request)
        #expect(configuration.readiness == .ready)
        let result = await built.provider.refresh(built.request)
        let batch = try #require(result.batch)
        #expect(result.outcome == .refreshed)
        #expect(batch.providerID == built.provider.descriptor.id)
        #expect(batch.fingerprint == configuration.fingerprint)
        #expect(batch.cacheRevision == configuration.cacheRevision)
        #expect(batch.coverage.start <= built.request.window.start)
        #expect(batch.coverage.end >= built.request.window.end)
        #expect(await built.provider.cachedForecast(for: built.request) == batch)
    }

    @Test("Solcast store results map to shared outcomes")
    func solcastOutcomes() async {
        let cases: [(SolarForecastRefreshResult, SolarForecastRefreshOutcome)] = [
            (.alreadyFresh, .fresh),
            (.budgetExhausted, .budgetExhausted),
            (.notConfigured, .setupRequired),
            (.failed(.unauthorized), .failed(.access)),
            (.failed(.requestFailed), .failed(.transient)),
            (.failed(.rateLimited), .deferred(until: nil)),
            (.failed(.unknownResource), .failed(.configuration)),
            (.failed(.invalidForecast), .failed(.invalidResponse)),
            (.failed(.saveFailed), .refreshed)]
        for (storeResult, outcome) in cases {
            let store = FakeSolcastStore()
            await store.configure(
                credential: SolarForecastCredential(
                    accountScopeID: "account-a", siteID: "site-a", credentialID: "c", resourceIDs: ["r"]
                ),
                batch: nil, result: storeResult
            )
            let result = await SolcastForecastProvider(store: store).refresh(Fixture.request(now: Self.now))
            #expect(result.outcome == outcome, "\(storeResult)")
        }
    }

    @Test("A Solcast credential without arrays is set-up-required, not absent")
    func solcastAwaitingArrays() async {
        let store = FakeSolcastStore()
        let provider = SolcastForecastProvider(store: store)
        #expect(await provider.configuration(for: Fixture.request(now: Self.now)).readiness == .notConfigured)
        await store.configure(
            credential: SolarForecastCredential(
                accountScopeID: "account-a",
                siteID: "site-a",
                credentialID: "c",
                resourceIDs: []
            ),
            batch: nil
        )
        #expect(await provider.configuration(for: Fixture.request(now: Self.now)).readiness == .setupRequired)
    }

    @Test("Solcast fingerprints follow credential and sorted resources")
    func solcastFingerprint() async {
        let store = FakeSolcastStore()
        let provider = SolcastForecastProvider(store: store)
        let request = Fixture.request(now: Self.now)
        await store.configure(
            credential: SolarForecastCredential(
                accountScopeID: "a",
                siteID: "s",
                credentialID: "c",
                resourceIDs: ["b", "a"]
            ),
            batch: nil
        )
        let first = await provider.configuration(for: request)
        await store.configure(
            credential: SolarForecastCredential(
                accountScopeID: "a",
                siteID: "s",
                credentialID: "c",
                resourceIDs: ["a", "b"]
            ),
            batch: nil
        )
        #expect(await provider.configuration(for: request).fingerprint == first.fingerprint)
        await store.configure(
            credential: SolarForecastCredential(
                accountScopeID: "a",
                siteID: "s",
                credentialID: "c",
                resourceIDs: ["a"]
            ),
            batch: nil
        )
        #expect(await provider.configuration(for: request).fingerprint != first.fingerprint)
    }

    @Test("Forecast.Solar geometry changes isolate configuration; a new detection time only changes the cache")
    func forecastSolarFingerprint() async {
        let harness = ForecastSolarHarness(clock: MutableSolarClock(Self.now), body: "")
        let base = await harness.provider.configuration(for: Fixture.request(now: Self.now))
        let redetected = await harness.provider.configuration(for: Fixture.request(
            now: Self.now, layout: Fixture.layout(detectedAt: Self.now)
        ))
        #expect(redetected.fingerprint == base.fingerprint)
        #expect(redetected.cacheRevision != base.cacheRevision)
        let moved = await harness.provider.configuration(for: Fixture.request(
            now: Self.now, layout: Fixture.layout(planes: [SolarLayoutPlane(azimuth: 180, tilt: 18, dcKwp: 5.6)])
        ))
        #expect(moved.fingerprint != base.fingerprint)
        let relocated = await harness.provider.configuration(for: Fixture.request(
            now: Self.now, location: SolarHomeLocation(latitude: 44, longitude: -87.87, source: .device)
        ))
        #expect(relocated.fingerprint != base.fingerprint)
        let missing = await harness.provider.configuration(for: Fixture.request(now: Self.now, location: nil))
        #expect(missing.readiness == .notConfigured)
    }
}
