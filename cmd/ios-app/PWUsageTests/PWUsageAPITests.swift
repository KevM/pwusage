import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("PWUsage API Tests", .serialized)
final class PWUsageAPITests {
    var cookieStorage: HTTPCookieStorage
    var session: URLSession
    var api: PWUsageAPI

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

    @Test("Foreground power uses the compact endpoint and rejects a different site's readings")
    func compactPowerTransport() async throws {
        let stamp = ISO8601DateFormatter().string(from: Date())
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
            #expect(components.path == "/api/mobile/live-power")
            #expect(components.queryItems?.contains(URLQueryItem(name: "siteId", value: "site-1")) == true)
            let json = """
            {"version":1,"siteID":"site-1",
             "live":{"solarPower":1000,"loadPower":500,"batteryPower":-500,"gridPower":0},
             "stateOfCharge":70,"sources":{"liveStatusAt":"\(stamp)","stateOfChargeAt":"\(stamp)"}}
            """
            return (try Self.response(request, status: 200), Data(json.utf8))
        }
        let reading = try await api.fetchLivePower(siteID: "site-1")
        #expect(reading.stateOfCharge == 70)
        #expect(reading.live.solarPower == 1000)
        #expect(throws: MobileLiveResponse.ContractError.self) { try reading.validating(siteID: "site-2") }
    }

    @Test("Battery hold reads and commands use an encoded site path and typed JSON")
    func batteryHoldTransport() async throws {
        var requests: [(URLRequest, Data)] = []
        StubURLProtocol.requestHandler = { request in
            requests.append((request, (try? Self.bodyData(from: request)) ?? Data()))
            let body = request.httpMethod == "POST"
                ? #"{"status":"reserve_changed","current":45}"#
                : #"{"hold":null,"notice":null}"#
            return (try Self.response(request, status: 200), Data(body.utf8))
        }
        #expect(try await api.fetchBatteryHold(siteID: "a/b ?#%").hold == nil)
        let result = try await api.sendBatteryHoldCommand(siteID: "a/b ?#%", command: .restore)
        #expect(result.status == .reserveChanged)
        #expect(result.current == 45)
        #expect(requests.count == 2)
        let url = try #require(requests.first?.0.url)
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
            == "/api/site/a%2Fb%20%3F%23%25/battery-hold")
        let post = requests[1]
        #expect(post.0.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(JSONSerialization.jsonObject(with: post.1) as? [String: Any])
        #expect(body["action"] as? String == "restore")
        #expect(body["durationHours"] == nil)
    }

    @Test("Live Activity registrations post the server's JSON shape and delete by registration id")
    func batteryHoldActivityTransport() async throws {
        var requests: [(URLRequest, Data)] = []
        StubURLProtocol.requestHandler = { request in
            requests.append((request, (try? Self.bodyData(from: request)) ?? Data()))
            let body = request.httpMethod == "POST"
                ? #"{"status":"registered","holdStatus":"active"}"#
                : #"{"status":"removed"}"#
            return (try Self.response(request, status: 200), Data(body.utf8))
        }
        let registrationID = try #require(UUID(uuidString: "6F1C2E1A-7B4D-4F45-9A0B-1C2D3E4F5A6B"))
        try await api.registerBatteryHoldActivity(siteID: "a/b", registration: .init(
            holdId: 7, registrationId: registrationID.uuidString.lowercased(),
            pushToken: String(repeating: "ab", count: 32), apnsEnvironment: .sandbox))
        try await api.unregisterBatteryHoldActivity(siteID: "a/b", registrationID: registrationID)
        #expect(requests.count == 2)
        let post = requests[0]
        #expect(post.0.httpMethod == "POST")
        #expect(post.0.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
            == "/api/site/a%2Fb/battery-hold/activities")
        #expect(post.0.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(JSONSerialization.jsonObject(with: post.1) as? [String: Any])
        #expect(body["holdId"] as? Int == 7)
        #expect(body["registrationId"] as? String == "6f1c2e1a-7b4d-4f45-9a0b-1c2d3e4f5a6b")
        #expect(body["pushToken"] as? String == String(repeating: "ab", count: 32))
        #expect(body["apnsEnvironment"] as? String == "sandbox")
        let delete = requests[1]
        #expect(delete.0.httpMethod == "DELETE")
        #expect(delete.0.url?.query == "registrationId=6f1c2e1a-7b4d-4f45-9a0b-1c2d3e4f5a6b")

        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 410), Data(#"{"error":"hold_ended"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.requestRejected(statusCode: 410, message: "hold_ended")) {
            try await api.unregisterBatteryHoldActivity(siteID: "a/b", registrationID: registrationID)
        }
    }

    @Test("Battery command permission errors remain actionable")
    func batteryHoldPermissionError() async {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 409), Data(#"{"error":"needs_reauth"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.requestRejected(statusCode: 409, message: "needs_reauth")) {
            try await api.sendBatteryHoldCommand(siteID: "site-1", command: .restore)
        }
    }

    @Test("Starting a hold sends the selected timer and reserve with the session cookie")
    func batteryHoldStartPayload() async throws {
        let cookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "test-session"
        ]))
        cookieStorage.setCookie(cookie)
        var recordedRequest: URLRequest?
        var recordedBody = Data()
        StubURLProtocol.requestHandler = { request in
            recordedRequest = request
            recordedBody = try Self.bodyData(from: request)
            return (try Self.response(request, status: 200),
                    Data("{\"status\":\"ok\",\"hold\":\(BatteryHoldTests.holdJSON)}".utf8))
        }
        let result = try await api.sendBatteryHoldCommand(
            siteID: "site-1", command: .park(.init(mode: .timer, durationHours: 6, reserveChoice: 80)))
        #expect(result.hold?.siteID == "site-1")
        #expect(recordedRequest?.value(forHTTPHeaderField: "Cookie") == "site_auth=test-session")
        let body = try #require(JSONSerialization.jsonObject(with: recordedBody) as? [String: Any])
        #expect(body["action"] as? String == "park")
        #expect(body["mode"] as? String == "timer")
        #expect(body["durationHours"] as? Int == 6)
        #expect(body["reserveChoice"] as? Int == 80)
    }

    static func liveFixture(siteID: String) -> String {
        """
        {"version":1,"site":{"id":"\(siteID)","name":"Home","timezone":"UTC","localDate":"2026-10-20"},
        "live":{"solarPower":0,"loadPower":0,"batteryPower":0,"gridPower":0},
        "today":{"homeKwh":1,"solarKwh":1,"gridNetKwh":0,"batteryNetKwh":0},"todayComplete":false,
        "stateOfCharge":null,"sources":{"energyDataThrough":null,"stateOfChargeAt":null}}
        """
    }

    static func response(_ request: URLRequest, status: Int) throws -> HTTPURLResponse {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url, statusCode: status, httpVersion: nil,
                  headerFields: ["Content-Type": "application/json"]) else {
            throw URLError(.badServerResponse)
        }
        return response
    }

    static func bodyData(from request: URLRequest) throws -> Data {
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

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
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

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

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
                    if let cookie = HTTPCookie(properties: [
                        .domain: url.host ?? "pwusage.test", .path: "/", .name: "site_auth",
                        .value: value, .discard: "TRUE"
                    ]) {
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
