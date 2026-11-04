import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("Unauthorized maps to sign-in required")
    func unauthorizedMapsToSignInRequired() async {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.signInRequired) {
            _ = try await api.fetchSites()
        }
    }

    @Test("Production cookie session uses injected storage and automatic cookie handling")
    func productionCookieSessionUsesInjectedStorageAndAutomaticCookieHandling() {
        let configuredSession = SharedWebSession.makeSession(cookieStorage: cookieStorage)
        defer { configuredSession.invalidateAndCancel() }

        #expect(configuredSession.configuration.httpCookieStorage === cookieStorage)
        #expect(configuredSession.configuration.httpShouldSetCookies)
        #expect(configuredSession.configuration.httpCookieAcceptPolicy == .always)
    }

    @Test("Server error maps to recoverable data error")
    func serverErrorMapsToRecoverableDataError() async {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 503), Data(#"{"error":"Unavailable"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            _ = try await api.fetchSites()
        }
    }

    @Test("Live response for another site is rejected, not displayed under the requested one")
    func liveSiteMismatchIsRejected() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 200), Data(Self.liveFixture(siteID: "other-site").utf8))
        }
        await #expect(throws: MobileLiveResponse.ContractError.siteMismatch(
            expected: "site-1", actual: "other-site")) {
            _ = try await api.fetchLive(siteID: "site-1")
        }
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 200), Data(Self.liveFixture(siteID: "site-1").utf8))
        }
        #expect(try await api.fetchLive(siteID: "site-1").site.id == "site-1")
    }

    @Test("A bill whose load timing omits nextStartPhraseByKey still decodes")
    func billWithoutNextStartPhrasesDecodes() async throws {
        StubURLProtocol.requestHandler = { request in
            let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC"},"#
                + #""currentBill":{"estimatedCost":2,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","#
                + #""cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"loadTiming":{"hasTariff":true,"#
                + #""hasCycleData":true,"activeIsCheapest":true,"periods":[],"pricingPeriods":[],"nextCheaper":null,"#
                + #""nextCheaperPhrase":null},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","#
                + #""energyDataThrough":null}}"#
            return (try Self.response(request, status: 200), Data(fixture.utf8))
        }
        let bill = try await api.fetchBill(siteID: "site-1")
        #expect(bill.loadTiming?.nextStartPhraseByKey == [:])
        #expect(bill.loadTiming?.activeIsCheapest == true)
    }

    @Test("The app session uses the shared no-cache, bounded-timeout policy")
    func appSessionUsesSharedPolicy() throws {
        let defaultAPI = PWUsageAPI(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
        )
        let shared = SharedWebSession.makeSession()
        defer { defaultAPI.session.invalidateAndCancel(); shared.invalidateAndCancel() }
        for configuration in [defaultAPI.session.configuration, shared.configuration] {
            #expect(configuration.timeoutIntervalForRequest == 20)
            #expect(configuration.timeoutIntervalForResource == 25)
            #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
            #expect(configuration.urlCache == nil)
            #expect(configuration.httpCookieStorage != nil)
            #expect(configuration.httpShouldSetCookies)
            #expect(configuration.httpCookieAcceptPolicy == .always)
        }
    }
}
