import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("PWUsage API Tests", .serialized)
final class PWUsageAPITests {
    private var cookieStorage: HTTPCookieStorage
    private var session: URLSession
    private var api: PWUsageAPI

    init() throws {
        let configuration = URLSessionConfiguration.ephemeral
        let storage = configuration.httpCookieStorage ?? HTTPCookieStorage.shared
        self.cookieStorage = storage
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpCookieStorage = storage
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        self.session = URLSession(configuration: configuration)
        StubURLProtocol.cookieStorage = storage
        // `pwusage.test` is a stub host that no Release build may name, so the
        // allowlist opt-out has to be explicit here.
        self.api = PWUsageAPI(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            session: session
        )
    }

    deinit {
        session.invalidateAndCancel()
        cookieStorage.cookies?.filter { $0.domain.contains("pwusage.test") }.forEach(cookieStorage.deleteCookie)
        StubURLProtocol.requestHandler = nil
        StubURLProtocol.cookieStorage = nil
    }

    @Test("Exchange cookie is sent on later API request")
    func exchangeCookieIsSentOnLaterAPIRequest() async throws {
        var recordedRequests: [(URLRequest, Data)] = []
        StubURLProtocol.requestHandler = { request in
            let body = (try? Self.bodyData(from: request)) ?? Data()
            recordedRequests.append((request, body))
            guard let url = request.url else { throw URLError(.badURL) }
            if url.path == "/api/mobile/session" {
                guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "site_auth=session-value; Path=/"]) else {
                    throw URLError(.badServerResponse)
                }
                return (response, Data(#"{"ok":true}"#.utf8))
            }
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else {
                throw URLError(.badServerResponse)
            }
            return (response, Data(#"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.utf8))
        }

        try await api.exchangeSession(MobileSessionExchange(attemptId: "attempt", code: "opaque-code", verifier: String(repeating: "v", count: 43), state: "app-state"))
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
        #expect(self.cookieStorage.cookies(for: secondURL)?.first(where: { $0.name == "site_auth" })?.value == "session-value")
        #expect(second.0.value(forHTTPHeaderField: "Cookie") == "site_auth=session-value")
    }

    @Test("Site ID is encoded as query item and bill response is decoded")
    func siteIDIsEncodedAsQueryItemAndBillResponseIsDecoded() async throws {
        var recordedRequest: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recordedRequest = request
            let fixture = #"{"version":1,"site":{"id":"site/one & two","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":12.5,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#
            return (try Self.response(request, status: 200), Data(fixture.utf8))
        }
        let bill = try await api.fetchBill(siteID: "site/one & two")
        #expect(bill.site.id == "site/one & two")
        let request = try #require(recordedRequest)
        let url = try #require(request.url)
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "siteId" })?.value == "site/one & two")
    }

    @Test("Planning context uses the authenticated PWUsage transport and typed contract")
    func planningContextUsesPWUsageTransport() async throws {
        var recordedRequest: URLRequest?
        let slots = (0..<48).map { index in
            "{\"localMinute\":\(index * 30),\"homeKw\":1.25,\"batteryNetChargeKw\":-0.1,\"sampleCount\":14,\"coverage\":1}"
        }.joined(separator: ",")
        let fixture = "{\"version\":1,\"site\":{\"id\":\"site/one & two\",\"timezone\":\"UTC\"},\"units\":{\"power\":\"kW\",\"localMinute\":\"minute-of-day\"},\"asOf\":\"2027-01-15T08:00:00Z\",\"availability\":\"available\",\"unavailableReason\":null,\"usableDayCount\":14,\"historyStart\":\"2027-01-01T00:00:00Z\",\"historyEnd\":\"2027-01-15T00:00:00Z\",\"slots\":[\(slots)]}"
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
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "siteId" })?.value == "site/one & two")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("Unauthorized maps to sign-in required")
    func unauthorizedMapsToSignInRequired() async {
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8)) }
        await #expect(throws: PWUsageAPIError.signInRequired) {
            _ = try await api.fetchSites()
        }
    }

    @Test("Production cookie session uses injected storage and automatic cookie handling")
    func productionCookieSessionUsesInjectedStorageAndAutomaticCookieHandling() {
        let configuredSession = PWUsageAPI.makeCookieSession(cookieStorage: cookieStorage)
        defer { configuredSession.invalidateAndCancel() }

        #expect(configuredSession.configuration.httpCookieStorage === cookieStorage)
        #expect(configuredSession.configuration.httpShouldSetCookies)
        #expect(configuredSession.configuration.httpCookieAcceptPolicy == .always)
    }

    @Test("Server error maps to recoverable data error")
    func serverErrorMapsToRecoverableDataError() async {
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 503), Data(#"{"error":"Unavailable"}"#.utf8)) }
        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            _ = try await api.fetchSites()
        }
    }

    private static func response(_ request: URLRequest, status: Int) throws -> HTTPURLResponse {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else {
            throw URLError(.badServerResponse)
        }
        return response
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
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) private static var _cookieStorage: HTTPCookieStorage?

    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _requestHandler
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _requestHandler = newValue
        }
    }

    static var cookieStorage: HTTPCookieStorage? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _cookieStorage
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _cookieStorage = newValue
        }
    }

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
