import Foundation
@testable import PWUsage
import Testing

@Suite("Solcast store raw history hook")
struct SolarForecastStoreHistoryTests {
    @Test("A successful Solcast refresh is recorded raw once, under its configuration identity")
    func recordsSuccessOnce() async throws {
        let recorder = HistoryRecorderSpy()
        let clock = MutableSolarClock(Date(timeIntervalSince1970: 1_790_000_000))
        let store = SolarForecastStore(
            clock: clock, keychain: MemoryKeychain(), files: MemoryForecastFiles(), transport: StaticSolcastTransport(),
            historyRecorder: recorder
        )
        let credentialID = try await store.connect(
            apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["west", "east"]
        )
        #expect(await store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        #expect(await store.refresh(accountScopeID: "account-a", siteID: "site-a") == .alreadyFresh)
        let records = await recorder.records
        #expect(records.count == 1)
        #expect(records.first?.identity == SolarForecastHistoryIdentity(
            accountScopeID: "account-a", siteID: "site-a", providerID: .solcast,
            fingerprint: SolcastForecastProvider.fingerprint(
                credentialID: credentialID,
                resourceIDs: ["east", "west"]
            )
        ))
        #expect(records.first?.fetchedAt == clock.now())
    }
}

private actor HistoryRecorderSpy: SolarForecastRawHistoryRecording {
    private(set) var records: [(identity: SolarForecastHistoryIdentity, fetchedAt: Date)] = []
    func record(identity: SolarForecastHistoryIdentity, intervals: [SolarForecastInterval], fetchedAt: Date) async {
        records.append((identity, fetchedAt))
    }
}

private actor MemoryKeychain: SolcastCredentialKeychain {
    private var values: [String: SolcastStoredCredential] = [:]
    func save(key: String, accountScopeID: String, siteID: String, credentialID: String) async throws {
        values[SolarForecastScope.key(accountScopeID, siteID)] = SolcastStoredCredential(
            key: key,
            credentialID: credentialID
        )
    }

    func load(accountScopeID: String, siteID: String) async throws -> SolcastStoredCredential? {
        values[SolarForecastScope.key(accountScopeID, siteID)]
    }

    func delete(accountScopeID: String, siteID: String) async throws {
        values[SolarForecastScope.key(accountScopeID, siteID)] = nil
    }

    func deleteAllCredentials() async throws { values.removeAll() }
}

private actor MemoryForecastFiles: SolarForecastPersistence {
    private var state = SolarForecastPersistedState()
    func loadState() async throws -> SolarForecastPersistedState { state }
    func saveState(_ state: SolarForecastPersistedState) async throws { self.state = state }
}

private struct StaticSolcastTransport: SolcastTransport {
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url ?? URL(fileURLWithPath: "/")
        let body = url.path == "/rooftop_sites"
            ? #"{"sites":[{"resource_id":"east","name":"East","tags":[]},"#
            + #"{"resource_id":"west","name":"West","tags":[]}]}"#
            : #"{"forecasts":[{"period_end":"2026-09-27T13:00:00Z","period":"PT30M","pv_estimate":2.0}]}"#
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)
        return (Data(body.utf8), response ?? URLResponse())
    }
}
