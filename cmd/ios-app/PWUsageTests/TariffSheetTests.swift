import Foundation
import Testing
@testable import PWUsage

@Suite("Tariff sheet")
struct TariffSheetTests {
    @Test func decodesSeasonsAndPeriods() throws {
        let response = try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: Data(Self.fixture.utf8))
        #expect(response.tariffs[0].seasons[0].periods[0].buyRate == 0.3)
        #expect(response.activeSummary(now: response.asOf) == "Winter · Peak")
        #expect(response.activeSummary(now: response.asOf.addingTimeInterval(61)) == nil)
        #expect(response.activeSummary(now: response.asOf.addingTimeInterval(-1)) == nil)
    }
    @Test func rejectsWrongSiteAndVersion() throws {
        let response = try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: Data(Self.fixture.utf8))
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "other") }
        #expect(throws: PWUsageAPIError.invalidResponse) {
            try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: Data(Self.fixture.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8)).validating(siteID: "a")
        }
    }
    static let fixture = #"{"version":1,"site":{"id":"a","name":"Home","timezone":"America/Chicago"},"currency":"USD","asOf":"2026-10-01T13:00:00Z","tariffs":[{"id":1,"name":"Residential","seasons":[{"id":2,"name":"Winter","dates":"Oct 1 – Apr 30","isActive":true,"periods":[{"id":3,"name":"Peak","days":"Mon – Fri","times":"8 AM – 8 PM","buyRate":0.3,"sellRate":0.1,"isActive":true}]}]}]}"#
}

@MainActor
@Suite("Tariff authorization")
struct TariffAuthorizationTests {
    @Test func requiresVerifiedSession() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.restoreLaunchCache(nil, sessionVerified: false)
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffs() }
        #expect(api.calls == 0)
        coordinator.authenticationRestored()
        _ = try await coordinator.fetchTariffs()
        #expect(api.calls == 1)
        coordinator.authenticationInvalidated()
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffs() }
        #expect(api.calls == 1)
    }

    @Test func discardsResponseAfterSiteSwitch() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.authenticationRestored()
        api.beforeReturn = { coordinator.selectSite("b") }
        await #expect(throws: CancellationError.self) { try await coordinator.fetchTariffs() }
    }

    @Test func unauthorizedResponseInvalidatesSession() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.authenticationRestored()
        api.error = .signInRequired
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffs() }
        #expect(coordinator.requiresSignIn)
    }
}

@MainActor
private final class TariffTestAPI: MobileDashboardDataAPI, MobileTariffDataAPI {
    var calls = 0
    var beforeReturn: (() -> Void)?
    var error: PWUsageAPIError?
    func fetchTariffs(siteID: String) async throws -> MobileTariffsResponse {
        calls += 1
        if let error { throw error }
        beforeReturn?()
        return try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: Data(TariffSheetTests.fixture.utf8))
    }
    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw PWUsageAPIError.invalidResponse }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }
}
