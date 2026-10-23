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
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == "/api/site/a%2Fb%20%3F%23%25/battery-hold")
        let post = requests[1]
        #expect(post.0.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(JSONSerialization.jsonObject(with: post.1) as? [String: NSObject])
        #expect(body["action"] == "restore" as NSString)
        #expect(body["durationHours"] == nil)
    }

    @Test("Live Activity registrations post the server's JSON shape and delete by registration id")
    func batteryHoldActivityTransport() async throws {
        var requests: [(URLRequest, Data)] = []
        StubURLProtocol.requestHandler = { request in
            requests.append((request, (try? Self.bodyData(from: request)) ?? Data()))
            let body = request.httpMethod == "POST" ? #"{"status":"registered","holdStatus":"active"}"# : #"{"status":"removed"}"#
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
        let body = try #require(JSONSerialization.jsonObject(with: post.1) as? [String: NSObject])
        #expect(body["holdId"] == 7 as NSNumber)
        #expect(body["registrationId"] == "6f1c2e1a-7b4d-4f45-9a0b-1c2d3e4f5a6b" as NSString)
        #expect(body["pushToken"] == String(repeating: "ab", count: 32) as NSString)
        #expect(body["apnsEnvironment"] == "sandbox" as NSString)
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
        let cookie = try #require(HTTPCookie(properties: [.domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "test-session"]))
        cookieStorage.setCookie(cookie)
        var recordedRequest: URLRequest?
        var recordedBody = Data()
        StubURLProtocol.requestHandler = { request in
            recordedRequest = request
            recordedBody = try Self.bodyData(from: request)
            return (try Self.response(request, status: 200), Data("{\"status\":\"ok\",\"hold\":\(BatteryHoldTests.holdJSON)}".utf8))
        }
        let result = try await api.sendBatteryHoldCommand(siteID: "site-1", command: .park(.init(mode: .timer, durationHours: 6, reserveChoice: 80)))
        #expect(result.hold?.siteID == "site-1")
        #expect(recordedRequest?.value(forHTTPHeaderField: "Cookie") == "site_auth=test-session")
        let body = try #require(JSONSerialization.jsonObject(with: recordedBody) as? [String: NSObject])
        #expect(body["action"] == "park" as NSString)
        #expect(body["mode"] == "timer" as NSString)
        #expect(body["durationHours"] == 6 as NSNumber)
        #expect(body["reserveChoice"] == 80 as NSNumber)
    }

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
            return (response, Data(TariffSheetTests.fixture.replacingOccurrences(of: "\"id\":\"a\"", with: "\"id\":\"other\"").utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) { try await api.fetchTariffs(siteID: "a") }
    }

    @Test("Tariff site ID stays in one encoded path segment")
    func tariffSiteIDIsEncoded() async throws {
        let siteID = "a/b ?#%"
        let body = Data(TariffSheetTests.fixture.replacingOccurrences(of: "\"id\":\"a\"", with: "\"id\":\"a/b ?#%\"").utf8)
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
        let configuredSession = SharedWebSession.makeSession(cookieStorage: cookieStorage)
        defer { configuredSession.invalidateAndCancel() }

        #expect(configuredSession.configuration.httpCookieStorage === cookieStorage)
        #expect(configuredSession.configuration.httpShouldSetCookies)
        #expect(configuredSession.configuration.httpCookieAcceptPolicy == .always)
    }

    @Test("Widget fetches today's totals without foregrounding the app")
    func widgetRefreshesIndependently() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        // Keep the offline check an hour later within the same UTC day.
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-20T12:00:00Z"))
        var saved = TodayEnergySnapshot.sample(at: now.addingTimeInterval(-3600))
        saved.energy.homeKwh = 1
        try store.save(saved)
        var requests = 0
        StubURLProtocol.requestHandler = { request in
            requests += 1
            let url = try #require(request.url)
            let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
            #expect(components.path == "/api/site-live-data")
            #expect(components.queryItems?.contains(URLQueryItem(name: "siteId", value: "preview")) == true)
            #expect(components.queryItems?.contains(URLQueryItem(name: "view", value: "mobile")) == true)
            let stamp = ISO8601DateFormatter().string(from: now)
            let day = TodayEnergySnapshot.localDate(now, timezone: "UTC")
            let body = """
            {"version":1,"site":{"id":"preview","name":"Home","timezone":"UTC","localDate":"\(day)"},
            "live":{"solarPower":0,"loadPower":0,"batteryPower":0,"gridPower":0},
            "today":{"homeKwh":42,"solarKwh":18,"gridNetKwh":-4,"batteryNetKwh":-2},"todayComplete":true,
            "stateOfCharge":78,"sources":{"energyDataThrough":"\(stamp)","stateOfChargeAt":"\(stamp)"}}
            """
            return (try Self.response(request, status: 200), Data(body.utf8))
        }
        let refresher = TodayEnergyWidgetRefresh(origin: URL(string: "https://pwusage.test")!, session: session, store: store)
        let updated = await refresher.load(at: now)
        #expect(requests == 1)
        #expect(updated?.energy.homeKwh == 42)
        #expect(updated?.stateOfCharge(at: now) == 78)
        #expect(store.load() == saved)

        StubURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        let offline = await refresher.load(at: now.addingTimeInterval(3600))
        #expect(offline?.energy.homeKwh == 42)
        #expect(offline?.availability(at: now.addingTimeInterval(3600)) == .stale)

        store.clear()
        #expect(await refresher.load(at: now) == nil)
    }

    @Test("Widget drops revoked data and discards results after logout or a site change")
    func widgetRejectsInvalidatedSelection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        let saved = TodayEnergySnapshot.sample(at: Date().addingTimeInterval(-3600))
        try store.save(saved)
        let refresher = TodayEnergyWidgetRefresh(origin: URL(string: "https://pwusage.test")!, session: session, store: store)
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 403), Data()) }
        #expect(await refresher.load(at: .now) == nil)
        StubURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        #expect(await refresher.load(at: .now) == nil)
        // Simulate sign-out while the extension's network request is in flight.
        StubURLProtocol.requestHandler = { request in
            store.clear()
            return (try Self.response(request, status: 503), Data())
        }
        #expect(await refresher.load(at: .now) == nil)
        try store.save(saved)
        let other = TodayEnergySnapshot(siteID: "other", siteName: "Other", timezone: saved.timezone,
                                        fetchedAt: saved.fetchedAt, energy: saved.energy)
        StubURLProtocol.requestHandler = { request in
            try store.save(other)
            return (try Self.response(request, status: 503), Data())
        }
        #expect(await refresher.load(at: .now) == other)
    }

    @Test("Widget uses receipt time for SOC refreshed during its request")
    func widgetDatesNewReadingsAtReceipt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        try store.save(.sample(at: Date().addingTimeInterval(-3600)))
        StubURLProtocol.requestHandler = { request in
            Thread.sleep(forTimeInterval: 0.05)
            // Fractional seconds make the timestamp strictly newer than request start.
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let now = Date()
            let stamp = formatter.string(from: now)
            let day = TodayEnergySnapshot.localDate(now, timezone: "UTC")
            let body = """
            {"version":1,"site":{"id":"preview","name":"Home","timezone":"UTC","localDate":"\(day)"},
            "live":{"solarPower":0,"loadPower":0,"batteryPower":0,"gridPower":0},
            "today":{"homeKwh":42,"solarKwh":18,"gridNetKwh":-4,"batteryNetKwh":-2},"todayComplete":true,
            "stateOfCharge":78,"sources":{"energyDataThrough":"\(stamp)","stateOfChargeAt":"\(stamp)"}}
            """
            Thread.sleep(forTimeInterval: 0.005)
            return (try Self.response(request, status: 200), Data(body.utf8))
        }
        let refresher = TodayEnergyWidgetRefresh(origin: URL(string: "https://pwusage.test")!, session: session, store: store)
        let result = await refresher.load()
        #expect(result?.energy.homeKwh == 42)
        #expect(result?.stateOfCharge(at: .now) == 78)
    }

    @Test("Existing app session migrates once and cannot return after sign-out")
    func widgetSessionMigration() throws {
        let legacy = try #require(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let shared = try #require(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let origin = URL(string: "https://pwusage.test")!
        let cookie = try #require(HTTPCookie(properties: [.domain: "pwusage.test", .path: "/", .name: "site_auth",
            .value: "existing-session", .expires: Date().addingTimeInterval(3600)]))
        legacy.setCookie(cookie)
        SharedWebSession.migrateSession(for: origin, from: legacy, to: shared)
        #expect(shared.cookies(for: origin)?.first?.value == "existing-session")
        #expect(legacy.cookies(for: origin)?.isEmpty != false)
        shared.cookies?.forEach(shared.deleteCookie)
        SharedWebSession.migrateSession(for: origin, from: legacy, to: shared)
        #expect(shared.cookies(for: origin)?.isEmpty != false)
    }

    @Test("Fresh-install cleanup removes only site_auth cookies from a shared jar")
    func freshInstallCookieClear() throws {
        let storage = try #require(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let siteCookie = try #require(HTTPCookie(properties: [.domain: "pwusage.test", .path: "/", .name: "site_auth",
            .value: "previous-session", .expires: Date().addingTimeInterval(3600)]))
        let otherCookie = try #require(HTTPCookie(properties: [.domain: "pwusage.test", .path: "/", .name: "display",
            .value: "compact"]))
        storage.setCookie(siteCookie)
        storage.setCookie(otherCookie)

        SharedWebSession.clearSessionCookies(in: storage)

        let remaining = storage.cookies ?? []
        #expect(!remaining.contains(where: { $0.name == "site_auth" }))
        #expect(remaining.contains(where: { $0.name == "display" }))
    }

    @Test("Server error maps to recoverable data error")
    func serverErrorMapsToRecoverableDataError() async {
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: 503), Data(#"{"error":"Unavailable"}"#.utf8)) }
        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            _ = try await api.fetchSites()
        }
    }

    @Test("Live response for another site is rejected, not displayed under the requested one")
    func liveSiteMismatchIsRejected() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 200), Data(Self.liveFixture(siteID: "other-site").utf8))
        }
        await #expect(throws: MobileLiveResponse.ContractError.siteMismatch(expected: "site-1", actual: "other-site")) {
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
            let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":2,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":true,"periods":[],"pricingPeriods":[],"nextCheaper":null,"nextCheaperPhrase":null},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#
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

    private static func liveFixture(siteID: String) -> String {
        """
        {"version":1,"site":{"id":"\(siteID)","name":"Home","timezone":"UTC","localDate":"2026-10-20"},
        "live":{"solarPower":0,"loadPower":0,"batteryPower":0,"gridPower":0},
        "today":{"homeKwh":1,"solarKwh":1,"gridNetKwh":0,"batteryNetKwh":0},"todayComplete":false,
        "stateOfCharge":null,"sources":{"energyDataThrough":null,"stateOfChargeAt":null}}
        """
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
