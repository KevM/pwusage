import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class RateCountryAPISpy: MobileDashboardDataAPI, MobileTariffDataAPI {
    var writes: [(siteID: String, body: SiteRateCountryWriteRequest)] = []
    var beforeReturn: (() -> Void)?
    var fetchedCountry: SiteRateCountryDTO?
    var fetches = 0

    func setSiteRateCountry(
        siteID: String,
        body: SiteRateCountryWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        writes.append((siteID, body))
        beforeReturn?()
        let eligibility: RatePlanEligibility = body.countryCode == "US" ? .unitedStates : .unknown
        return Self.timeline(
            siteID: siteID,
            country: SiteRateCountryDTO(
                countryCode: body.countryCode, source: body.countryCode == nil ? nil : body.source,
                updatedAt: nil, eligibility: eligibility
            )
        )
    }

    static func timeline(siteID: String, country: SiteRateCountryDTO?) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2, siteId: siteID, timezone: "America/Chicago", currency: "USD", periods: [],
            reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil,
                activeManualUpdatedAt: nil, differsFromActiveManual: false,
                syncAvailable: false, syncUnavailableReason: nil, lastSync: nil
            ),
            rateCountry: country
        )
    }

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        guard let fetchedCountry else { throw PWUsageAPIError.invalidResponse }
        fetches += 1
        return Self.timeline(siteID: siteID, country: fetchedCountry)
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func createTariffPeriod(siteID: String, body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func updateTariffPeriod(
        siteID: String, periodID: Int, body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
}

@MainActor
@Suite("Reporting a site's country from its saved home location")
struct SiteRateCountryCoordinatorTests {
    private static let chicago = SolarHomeLocation(latitude: 41.88, longitude: -87.63, source: .device)
    private static let detroitRiverfront = SolarHomeLocation(latitude: 42.33, longitude: -83.04, source: .device)
    private static let unknown = SiteRateCountryDTO(
        countryCode: nil, source: nil, updatedAt: nil, eligibility: .unknown
    )

    private let api = RateCountryAPISpy()
    private let records: SolarLayoutRecordStore
    private let coordinator: DashboardCoordinator

    init() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rate-country-\(UUID().uuidString)", isDirectory: true)
        records = SolarLayoutRecordStore(directory: directory.appendingPathComponent("SolarLayout"))
        coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, accountScopeID: "account-a", timerInterval: nil,
            records: records,
            ratePlanTimelines: RatePlanTimelineStore(directory: directory.appendingPathComponent("Timelines"))
        )
    }

    private func save(
        _ location: SolarHomeLocation,
        siteID: String = "site-a",
        account: String = "account-a"
    ) async throws {
        try await records.setLocation(location, scope: SolarForecastSiteScope(accountScopeID: account, siteID: siteID))
    }

    @Test("A resolved location reports only the country code, as an inference")
    func reportsCountry() async throws {
        try await save(Self.chicago)
        await coordinator.syncSiteRateCountry(stored: Self.unknown)
        #expect(api.writes.count == 1)
        #expect(api.writes.first?.siteID == "site-a")
        #expect(api.writes.first?.body == SiteRateCountryWriteRequest(countryCode: "US", source: .solarLocation))
        let body = try #require(api.writes.first?.body)
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(Set(object.keys) == ["countryCode", "source"], "No coordinates are sent")
    }

    @Test("An owner's choice is never replaced by inference")
    func ownerWins() async throws {
        try await save(Self.chicago)
        let owner = SiteRateCountryDTO(countryCode: "CA", source: .owner, updatedAt: nil, eligibility: .outsideUS)
        await coordinator.syncSiteRateCountry(stored: owner)
        #expect(api.writes.isEmpty)
    }

    @Test("A location near a border clears a stale inference instead of guessing")
    func borderClearsInference() async throws {
        try await save(Self.detroitRiverfront)
        let inferred = SiteRateCountryDTO(
            countryCode: "US", source: .solarLocation, updatedAt: nil, eligibility: .unitedStates
        )
        await coordinator.syncSiteRateCountry(stored: inferred)
        #expect(api.writes.map(\.body) == [SiteRateCountryWriteRequest(countryCode: nil, source: .solarLocation)])
        guard case .nearBorder(let candidates) = await coordinator.siteCountryInference() else {
            Issue.record("Expected the owner to be asked near the border")
            return
        }
        #expect(Set(candidates) == ["US", "CA"])
    }

    @Test("Another site's or another account's location is never used")
    func scopeIsolation() async throws {
        try await save(Self.chicago, siteID: "site-b")
        try await save(Self.chicago, account: "account-b")
        await coordinator.syncSiteRateCountry(stored: Self.unknown)
        #expect(api.writes.isEmpty)
        #expect(await coordinator.siteCountryInference() == .noLocation)
    }

    @Test("A site change while the country is saved discards the response")
    func staleCompletion() async throws {
        try await save(Self.chicago)
        api.beforeReturn = { coordinator.selectSite("site-b") }
        await coordinator.syncSiteRateCountry(stored: Self.unknown)
        #expect(api.writes.count == 1)
        let saved = await coordinator.savedTimeline(for: coordinator.tariffScope(siteID: "site-a"))
        #expect(saved == nil, "The completion for site-a was dropped after switching sites")
    }

    @Test("Loading Rate Plans returns the timeline with the inferred country, not the stale one")
    func loadReturnsReportedCountry() async throws {
        try await save(Self.chicago)
        api.fetchedCountry = Self.unknown
        let loaded = try await coordinator.fetchTariffTimeline()
        #expect(loaded.rateCountry?.countryCode == "US")
        #expect(loaded.rateCountry?.eligibility == .unitedStates)
        // Let any background work run, then check the country was reported only once.
        for _ in 0 ..< 20 { await Task.yield() }
        #expect(api.writes.count == 1)
    }

    @Test("Loading Rate Plans without a location returns the fetched timeline unchanged")
    func loadWithoutLocation() async throws {
        api.fetchedCountry = Self.unknown
        let loaded = try await coordinator.fetchTariffTimeline()
        #expect(loaded.rateCountry == Self.unknown)
        #expect(api.writes.isEmpty)
    }
}
