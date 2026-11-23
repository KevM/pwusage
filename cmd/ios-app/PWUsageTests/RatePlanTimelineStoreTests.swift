import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@MainActor
@Suite("Rate plan timeline store")
struct RatePlanTimelineStoreTests {
    private let scopeA = SolarForecastSiteScope(accountScopeID: "account-1", siteID: "a")
    private let scopeB = SolarForecastSiteScope(accountScopeID: "account-1", siteID: "b")

    @Test("Revalidating with 304 keeps the saved copy intact")
    func unchangedKeepsSavedCopy() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = RatePlanTimelineStore(directory: folder)
        let initial = try decodeFixture(siteID: "a")
        try await store.save(initial, etag: "\"etag-v1\"", scope: scopeA)

        let api = RevalidatingTariffTestAPI(nextFetch: .unchanged)
        let coordinator = DashboardCoordinator(
            siteID: "a",
            api: api,
            accountScopeID: "account-1",
            timerInterval: nil,
            ratePlanTimelines: store
        )
        coordinator.authenticationRestored()

        let result = try await coordinator.revalidateTariffTimeline()
        #expect(result == initial)
        #expect(api.lastKnownETag == "\"etag-v1\"")
        let saved = try #require(await store.saved(scope: scopeA))
        #expect(saved.timeline == initial)
        #expect(saved.etag == "\"etag-v1\"")
    }

    @Test("Editor responses replace the saved copy immediately")
    func editorResponseReplacesSavedCopy() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = RatePlanTimelineStore(directory: folder)
        let initial = try decodeFixture(siteID: "a", currency: "USD")
        try await store.save(initial, etag: "\"etag-v1\"", scope: scopeA)

        let updated = try decodeFixture(siteID: "a", currency: "CAD")
        let api = RevalidatingTariffTestAPI(
            nextFetch: .changed(updated, etag: "\"etag-v2\""),
            mutationResponse: updated
        )
        let coordinator = DashboardCoordinator(
            siteID: "a",
            api: api,
            accountScopeID: "account-1",
            timerInterval: nil,
            ratePlanTimelines: store
        )
        coordinator.authenticationRestored()

        let fetched = try await coordinator.fetchTariffTimeline()
        #expect(fetched == updated)
        let afterFetch = try #require(await store.saved(scope: scopeA))
        #expect(afterFetch.timeline == updated)
        #expect(afterFetch.etag == "\"etag-v2\"")

        let edited = try decodeFixture(siteID: "a", currency: "GBP")
        api.mutationResponse = edited
        let created = try await coordinator.createTariffPeriod(sampleWriteRequest())
        #expect(created == edited)
        let afterCreate = try #require(await store.saved(scope: scopeA))
        #expect(afterCreate.timeline == edited)
    }

    @Test("Sign-out removes saved rate plan timelines")
    func signOutRemovesSavedTimelines() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("records")) { nil }
        let timelines = RatePlanTimelineStore(directory: folder.appendingPathComponent("timelines"))
        try await timelines.save(try decodeFixture(siteID: "a"), etag: "\"etag-a\"", scope: scopeA)
        try await timelines.save(try decodeFixture(siteID: "b"), etag: "\"etag-b\"", scope: scopeB)

        let sync = try makeCloudSync(records: records, folder: folder)
        let cleanup = SolarSessionCleanup(
            historyStore: SolarHistoryStore(directory: folder.appendingPathComponent("history")),
            layoutRecordStore: records,
            cloudSync: sync,
            ratePlanTimelineStore: timelines
        )

        try await cleanup.signOut()

        let reloaded = RatePlanTimelineStore(directory: folder.appendingPathComponent("timelines"))
        #expect(try await reloaded.saved(scope: scopeA) == nil)
        #expect(try await reloaded.saved(scope: scopeB) == nil)
    }

    nonisolated private func makeCloudSync(
        records: SolarLayoutRecordStore,
        folder: URL
    ) throws -> SolarLayoutCloudSync {
        let defaults = try #require(UserDefaults(suiteName: "TimelineCleanup.\(UUID().uuidString)"))
        return SolarLayoutCloudSync(
            store: records,
            userDefaults: defaults,
            stateURL: folder.appendingPathComponent("state.json"),
            systemFieldsURL: folder.appendingPathComponent("fields.json"),
            pendingScopesURL: folder.appendingPathComponent("pending.json")
        )
    }

    private func decodeFixture(siteID: String, currency: String = "USD") throws -> SiteTariffsTimelineResponse {
        let raw = TariffSheetTests.fixture
            .replacingOccurrences(of: "\"siteId\":\"a\"", with: "\"siteId\":\"\(siteID)\"")
            .replacingOccurrences(of: "\"currency\":\"USD\"", with: "\"currency\":\"\(currency)\"")
        return try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(raw.utf8)
        )
    }

    private func sampleWriteRequest() -> TariffPlanWriteRequest {
        let period = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: 0.1,
            sellRate: 0.03
        )
        return TariffPlanWriteRequest(
            name: "Plan",
            effectiveFrom: "2026-01-01",
            effectiveTo: nil,
            seasons: [
                TariffSeasonInput(
                    name: "All Year",
                    fromMonth: 1,
                    toMonth: 12,
                    weekdayPeriods: [period],
                    weekendPeriods: [period]
                )
            ]
        )
    }
}

@MainActor
private final class RevalidatingTariffTestAPI: MobileDashboardDataAPI, MobileTariffDataAPI {
    var nextFetch: TimelineFetch
    var mutationResponse: SiteTariffsTimelineResponse?
    var lastKnownETag: String?

    init(nextFetch: TimelineFetch, mutationResponse: SiteTariffsTimelineResponse? = nil) {
        self.nextFetch = nextFetch
        self.mutationResponse = mutationResponse
    }

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        switch nextFetch {
        case .changed(let timeline, _):
            return timeline
        case .unchanged:
            throw PWUsageAPIError.invalidResponse
        }
    }

    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch {
        lastKnownETag = knownETag
        return nextFetch
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try requireMutationResponse()
    }

    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try requireMutationResponse()
    }

    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try requireMutationResponse()
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        try requireMutationResponse()
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try requireMutationResponse()
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        throw PWUsageAPIError.invalidResponse
    }

    private func requireMutationResponse() throws -> SiteTariffsTimelineResponse {
        guard let mutationResponse else { throw PWUsageAPIError.invalidResponse }
        return mutationResponse
    }
}
