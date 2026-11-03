import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("Tariff request is site-scoped and validates response identity")
    func tariffRequestIsSiteScoped() async throws {
        var recordedURL: URL?
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            recordedURL = url
            let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
            return (response, Data(TariffSheetTests.fixture.utf8))
        }
        let tariffs = try await api.fetchTariffs(siteID: "a")
        #expect(recordedURL?.path == "/api/site/a/refresh-tariffs")
        let url = try #require(recordedURL)
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == nil)
        #expect(tariffs.tariffs[0].seasons[0].periods[0].isActive)
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
            return (response, Data(TariffSheetTests.fixture.replacingOccurrences(
                of: "\"id\":\"a\"", with: "\"id\":\"other\"").utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) { try await api.fetchTariffs(siteID: "a") }
    }

    @Test("Tariff site ID stays in one encoded path segment")
    func tariffSiteIDIsEncoded() async throws {
        let siteID = "a/b ?#%"
        let body = Data(TariffSheetTests.fixture.replacingOccurrences(
            of: "\"id\":\"a\"", with: "\"id\":\"a/b ?#%\"").utf8)
        var recordedURL: URL?
        StubURLProtocol.requestHandler = { request in
            recordedURL = request.url
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
                throw URLError(.badServerResponse)
            }
            return (response, body)
        }
        _ = try await api.fetchTariffs(siteID: siteID)
        let url = try #require(recordedURL)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.percentEncodedPath == "/api/site/a%2Fb%20%3F%23%25/refresh-tariffs")
        #expect(components.query == nil)
        #expect(components.fragment == nil)
    }

    @Test("Exchange cookie is sent on later API request")
    func exchangeCookieIsSentOnLaterAPIRequest() async throws {
        var recordedRequests: [(URLRequest, Data)] = []
        StubURLProtocol.requestHandler = { request in
            let body = (try? Self.bodyData(from: request)) ?? Data()
            recordedRequests.append((request, body))
            guard let url = request.url else { throw URLError(.badURL) }
            if url.path == "/api/mobile/session" {
                guard let response = HTTPURLResponse(
                    url: url, statusCode: 200, httpVersion: nil,
                    headerFields: ["Set-Cookie": "site_auth=session-value; Path=/"]) else {
                    throw URLError(.badServerResponse)
                }
                return (response, Data(#"{"ok":true}"#.utf8))
            }
            guard let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]) else {
                throw URLError(.badServerResponse)
            }
            return (response, Data(#"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.utf8))
        }

        try await api.exchangeSession(
            MobileSessionExchange(attemptId: "attempt", code: "opaque-code",
                                  verifier: String(repeating: "v", count: 43), state: "app-state"))
        let sites = try await api.fetchSites()
        #expect(sites.map(\.id) == ["site-1"])
        #expect(recordedRequests.count == 2)

        let first = try #require(recordedRequests.first)
        #expect(first.0.httpMethod == "POST")
        #expect(first.0.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let exchange = try JSONDecoder().decode(MobileSessionExchange.self, from: first.1)
        #expect(exchange.attemptId == "attempt")

        let second = recordedRequests[1]
        let secondURL = try #require(second.0.url)
        #expect(secondURL.path == "/api/sites")
        #expect(self.cookieStorage.cookies(for: secondURL)?.first(where: { $0.name == "site_auth" })?.value
            == "session-value")
        #expect(second.0.value(forHTTPHeaderField: "Cookie") == "site_auth=session-value")
    }

    /// The server may replace site_auth mid-session (sliding refresh, or a fresh
    /// login stamped with the DB session_version after sign-out-everywhere).
    /// iOS treats the cookie value as opaque: the proxy's Set-Cookie must replace
    /// the stored copy and the next request must replay the new value, with no
    /// client-side parsing of the `sv` claim.
    @Test("Server-refreshed versioned session cookie replaces the stored one opaquely")
    func refreshedSessionCookieReplacesStoredOne() async throws {
        let stale = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "old.stale.token"
        ]))
        cookieStorage.setCookie(stale)

        let refreshedValue = "header.eyJzdiI6MX0.signature"
        var recordedRequests: [URLRequest] = []
        StubURLProtocol.requestHandler = { request in
            recordedRequests.append(request)
            guard let url = request.url else { throw URLError(.badURL) }
            if url.path == "/api/sites" {
                // Proxy-style sliding refresh: 200 plus a replacement session cookie.
                guard let replaced = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [
                    "Content-Type": "application/json",
                    "Set-Cookie": "site_auth=\(refreshedValue); Path=/; HttpOnly; SameSite=Lax"
                ]) else { throw URLError(.badServerResponse) }
                return (replaced, Data(#"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.utf8))
            }
            return (try Self.response(request, status: 200), Data(#"[]"#.utf8))
        }

        _ = try await api.fetchSites()
        let secondURL = try #require(URL(string: "https://pwusage.test/api/sites"))
        let stored = cookieStorage.cookies(for: secondURL)?.first { $0.name == "site_auth" }
        #expect(stored?.value == refreshedValue)

        _ = try await api.fetchSites()
        #expect(recordedRequests.last?.value(forHTTPHeaderField: "Cookie") == "site_auth=\(refreshedValue)")
    }

    @Test("Site ID is encoded as query item and bill response is decoded")
    func siteIDIsEncodedAsQueryItemAndBillResponseIsDecoded() async throws {
        var recordedRequest: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recordedRequest = request
            let fixture = #"{"version":1,"site":{"id":"site/one & two","name":"Home","timezone":"UTC"},"#
                + #""currentBill":{"estimatedCost":12.5,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","#
                + #""cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"#
                + #""sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#
            return (try Self.response(request, status: 200), Data(fixture.utf8))
        }
        let bill = try await api.fetchBill(siteID: "site/one & two")
        #expect(bill.site.id == "site/one & two")
        let request = try #require(recordedRequest)
        let url = try #require(request.url)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.queryItems?.first(where: { $0.name == "siteId" })?.value
            == "site/one & two")
    }

    @Test("Planning context uses the authenticated PWUsage transport and typed contract")
    func planningContextUsesPWUsageTransport() async throws {
        var recordedRequest: URLRequest?
        let slots = (0 ..< 48).map { index in
            "{\"localMinute\":\(index * 30),\"homeKw\":1.25,\"batteryNetChargeKw\":-0.1,\"sampleCount\":14,"
                + "\"coverage\":1}"
        }.joined(separator: ",")
        let fixture = "{\"version\":1,\"site\":{\"id\":\"site/one & two\",\"timezone\":\"UTC\"},"
            + "\"units\":{\"power\":\"kW\",\"localMinute\":\"minute-of-day\"},\"asOf\":\"2027-01-15T08:00:00Z\","
            + "\"availability\":\"available\",\"unavailableReason\":null,\"usableDayCount\":14,"
            + "\"historyStart\":\"2027-01-01T00:00:00Z\",\"historyEnd\":\"2027-01-15T00:00:00Z\",\"slots\":["
            + "\(slots)]}"
        StubURLProtocol.requestHandler = { request in
            recordedRequest = request
            return (try Self.response(request, status: 200), Data(fixture.utf8))
        }

        let context = try await api.fetchLoadPlanningContext(siteID: "site/one & two")

        #expect(context.site.id == "site/one & two")
        #expect(context.slots.count == 48)
        #expect(context.slots[0].batteryNetChargeKw == -0.1)
        let request = try #require(recordedRequest)
        let url = try #require(request.url)
        #expect(url.path == "/api/mobile/load-planning-context")
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.queryItems?.first(where: { $0.name == "siteId" })?.value
            == "site/one & two")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }
}
