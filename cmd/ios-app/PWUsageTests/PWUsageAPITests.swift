import Foundation
import XCTest
@testable import PWUsage

final class PWUsageAPITests: XCTestCase {
    private var cookieStorage: HTTPCookieStorage!
    private var session: URLSession!
    private var api: PWUsageAPI!

    override func setUp() {
        super.setUp()
        cookieStorage = .shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpCookieStorage = cookieStorage
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: configuration)
        StubURLProtocol.cookieStorage = cookieStorage
        api = PWUsageAPI(configuration: try! AppConfiguration(apiOriginString: "https://pwusage.test"), session: session)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        cookieStorage.cookies?.filter { $0.domain.contains("pwusage.test") }.forEach(cookieStorage.deleteCookie)
        StubURLProtocol.requestHandler = nil
        StubURLProtocol.cookieStorage = nil
        api = nil
        session = nil
        cookieStorage = nil
        super.tearDown()
    }

    func testExchangeCookieIsSentOnLaterAPIRequest() async throws {
        let requestExpectation = expectation(description: "exchange then sites request")
        requestExpectation.expectedFulfillmentCount = 2
        StubURLProtocol.requestHandler = { request in
            requestExpectation.fulfill()
            if request.url?.path == "/api/mobile/session" {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
                let body = try Self.bodyData(from: request)
                let exchange = try JSONDecoder().decode(MobileSessionExchange.self, from: body)
                XCTAssertEqual(exchange.attemptId, "attempt")
                let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "site_auth=session-value; Path=/"]))
                return (response, Data(#"{"ok":true}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/sites")
            XCTAssertEqual(self.cookieStorage.cookies(for: try XCTUnwrap(request.url))?.first(where: { $0.name == "site_auth" })?.value, "session-value")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "site_auth=session-value")
            let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            return (response, Data(#"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.utf8))
        }

        try await api.exchangeSession(MobileSessionExchange(attemptId: "attempt", code: "opaque-code", verifier: String(repeating: "v", count: 43), state: "app-state"))
        let sites = try await api.fetchSites()
        XCTAssertEqual(sites.map(\.id), ["site-1"])
        await fulfillment(of: [requestExpectation], timeout: 2)
    }

    func testSiteIDIsEncodedAsQueryItemAndBillResponseIsDecoded() async throws {
        StubURLProtocol.requestHandler = { request in
            XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "siteId" })?.value, "site/one & two")
            let fixture = #"{"version":1,"site":{"id":"site/one & two","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":12.5,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#
            return (try Self.response(request, status: 200), Data(fixture.utf8))
        }
        let bill = try await api.fetchBill(siteID: "site/one & two")
        XCTAssertEqual(bill.site.id, "site/one & two")
    }

    func testUnauthorizedMapsToSignInRequired() async {
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8)) }
        do {
            _ = try await api.fetchSites()
            XCTFail("Expected sign-in required")
        } catch {
            XCTAssertEqual(error as? PWUsageAPIError, .signInRequired)
        }
    }

    func testProductionCookieSessionUsesInjectedStorageAndAutomaticCookieHandling() {
        let configuredSession = PWUsageAPI.makeCookieSession(cookieStorage: cookieStorage)
        defer { configuredSession.invalidateAndCancel() }

        XCTAssertTrue(configuredSession.configuration.httpCookieStorage === cookieStorage)
        XCTAssertTrue(configuredSession.configuration.httpShouldSetCookies)
        XCTAssertEqual(configuredSession.configuration.httpCookieAcceptPolicy, .always)
    }

    func testServerErrorMapsToRecoverableDataError() async {
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 503), Data(#"{"error":"Unavailable"}"#.utf8)) }
        do {
            _ = try await api.fetchSites()
            XCTFail("Expected recoverable error")
        } catch {
            XCTAssertEqual(error as? PWUsageAPIError, .recoverableServerError(statusCode: 503))
        }
    }

    private static func response(_ request: URLRequest, status: Int) throws -> HTTPURLResponse {
        try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
    }

    private static func bodyData(from request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { throw PWUsageAPIError.invalidResponse }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? PWUsageAPIError.invalidResponse }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var cookieStorage: HTTPCookieStorage?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let requestHandler = Self.requestHandler else { throw URLError(.unsupportedURL) }
            var request = request
            if let url = request.url, let cookies = Self.cookieStorage?.cookies(for: url), !cookies.isEmpty {
                let fields = HTTPCookie.requestHeaderFields(with: cookies)
                for (name, value) in fields where request.value(forHTTPHeaderField: name) == nil {
                    request.setValue(value, forHTTPHeaderField: name)
                }
            }
            let (response, data) = try requestHandler(request)
            // URLProtocol interception bypasses URLSession's normal cookie policy hooks.
            // Simulate response storage and subsequent Cookie-header dispatch in this stub;
            // production uses URLSession's configured HTTPCookieStorage automatically.
            if let url = request.url, let cookieStorage = Self.cookieStorage {
                let cookieHeader = response.value(forHTTPHeaderField: "Set-Cookie")
                if let cookieHeader, cookieHeader.hasPrefix("site_auth=") {
                    let value = String(cookieHeader.dropFirst("site_auth=".count).prefix { $0 != ";" })
                    if let cookie = HTTPCookie(properties: [.domain: url.host ?? "pwusage.test", .path: "/", .name: "site_auth", .value: value, .discard: "TRUE"]) {
                        cookieStorage.setCookie(cookie)
                    }
                }
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
