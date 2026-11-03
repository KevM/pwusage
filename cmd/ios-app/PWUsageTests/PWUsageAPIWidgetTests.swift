import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
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
        let refresher = TodayEnergyWidgetRefresh(
            origin: URL(string: "https://pwusage.test")!, session: session, store: store)
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
        let refresher = TodayEnergyWidgetRefresh(
            origin: URL(string: "https://pwusage.test")!, session: session, store: store)
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
        let refresher = TodayEnergyWidgetRefresh(
            origin: URL(string: "https://pwusage.test")!, session: session, store: store)
        let result = await refresher.load()
        #expect(result?.energy.homeKwh == 42)
        #expect(result?.stateOfCharge(at: .now) == 78)
    }

    @Test("Existing app session migrates once and cannot return after sign-out")
    func widgetSessionMigration() throws {
        let legacy = try #require(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let shared = try #require(URLSessionConfiguration.ephemeral.httpCookieStorage)
        let origin = URL(string: "https://pwusage.test")!
        let cookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth",
            .value: "existing-session", .expires: Date().addingTimeInterval(3600)
        ]))
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
        let siteCookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth",
            .value: "previous-session", .expires: Date().addingTimeInterval(3600)
        ]))
        let otherCookie = try #require(HTTPCookie(properties: [.domain: "pwusage.test", .path: "/", .name: "display",
                                                               .value: "compact"]))
        storage.setCookie(siteCookie)
        storage.setCookie(otherCookie)

        SharedWebSession.clearSessionCookies(in: storage)

        let remaining = storage.cookies ?? []
        #expect(!remaining.contains(where: { $0.name == "site_auth" }))
        #expect(remaining.contains(where: { $0.name == "display" }))
    }
}
