import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("Tesla reconnect response remains distinct from an invalid app session")
    func teslaReconnectTransport() async throws {
        StubURLProtocol.requestHandler = { request in
            let body = #"{"code":"TESLA_CONNECTION_REQUIRED","error":"Reconnect Tesla to update your data."}"#
            return (try Self.response(request, status: 409), Data(body.utf8))
        }
        await #expect(throws: PWUsageAPIError.requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED")) {
            try await api.fetchLivePower(siteID: "site-1")
        }
    }

    @Test("Widget reconnect preserves stored data and session; app authorization failure clears the widget")
    func widgetReconnectPreservesStoredData() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        let source = Date().addingTimeInterval(-3600)
        let snapshot = TodayEnergySnapshot(
            siteID: "home", siteName: "Home", timezone: "UTC", fetchedAt: source,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(source, timezone: "UTC"),
                                homeKwh: 12, solarKwh: 18, gridNetKwh: -4, batteryNetKwh: -2,
                                energyDataThrough: source))
        try store.save(snapshot)
        let origin = try #require(URL(string: "https://pwusage.test"))
        let cookie = try #require(HTTPCookie(properties:
            [.domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "valid-session"]))
        cookieStorage.setCookie(cookie)
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 409), Data(#"{"code":"TESLA_CONNECTION_REQUIRED"}"#.utf8))
        }
        let refresh = TodayEnergyWidgetRefresh(origin: origin, session: session, store: store)
        #expect(await refresh.load() == snapshot)
        #expect(store.load() == snapshot)
        #expect(cookieStorage.cookies(for: origin)?.contains { $0.value == "valid-session" } == true)
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 401), Data())
        }
        #expect(await refresh.load() == nil)
        StubURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        #expect(await refresh.load() == nil, "Transport failure must not restore data rejected by authorization.")
    }
}
