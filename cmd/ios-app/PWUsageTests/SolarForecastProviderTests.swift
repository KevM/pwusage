import Foundation
@testable import PWUsage
import Testing

@Suite("Solar forecast provider contract")
struct SolarForecastProviderTests {
    private typealias Fixture = SolarProviderFixture
    private static let now = Fixture.date("2026-10-28 09:00:00")

    enum Kind: CaseIterable, Sendable { case openMeteo, synthetic }

    private struct Built {
        let provider: any SolarForecastProviding
        let request: SolarForecastRequest
    }

    private static func build(_ kind: Kind) async -> Built {
        let clock = MutableSolarClock(now)
        let request = Fixture.request(now: now)
        switch kind {
        case .openMeteo:
            let harness = OpenMeteoHarness(clock: clock, body: Fixture.openMeteoBody(now: now))
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

    @Test("Open-Meteo geometry changes isolate configuration; a new detection time only changes the cache")
    func openMeteoFingerprint() async {
        let provider = OpenMeteoHarness(clock: MutableSolarClock(Self.now), body: Data()).provider
        let base = await provider.configuration(for: Fixture.request(now: Self.now))
        let redetected = await provider.configuration(for: Fixture.request(
            now: Self.now, layout: Fixture.layout(detectedAt: Self.now)
        ))
        #expect(redetected.fingerprint == base.fingerprint)
        #expect(redetected.cacheRevision != base.cacheRevision)
        let moved = await provider.configuration(for: Fixture.request(
            now: Self.now, layout: Fixture.layout(planes: [SolarLayoutPlane(azimuth: 180, tilt: 18, dcKwp: 5.6)])
        ))
        #expect(moved.fingerprint != base.fingerprint)
        let relocated = await provider.configuration(for: Fixture.request(
            now: Self.now, location: SolarHomeLocation(latitude: 44, longitude: -87.87, source: .device)
        ))
        #expect(relocated.fingerprint != base.fingerprint)
        let missing = await provider.configuration(for: Fixture.request(now: Self.now, location: nil))
        #expect(missing.readiness == .notConfigured)
    }
}
