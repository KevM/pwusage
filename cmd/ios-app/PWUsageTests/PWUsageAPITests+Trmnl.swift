import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("Trmnl devices come from the site's devices route")
    func fetchTrmnlDevices() async throws {
        var recorded: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recorded = request
            let json = """
            {"devices":[{"id":4,"uuid":"abcdef12-0000","pluginSettingId":9,"connectedAt":null,
              "screen":{"name":"Screen 2","index":1,"count":3,"componentConfig":{"showLiveGrid":true,
              "showLiveSolar":true,"showLiveBattery":true,"showEnergyChart":false,"showBatterySoc":false,
              "showEstimatedBill":false,"showLoadTiming":false,"batterySocMode":"glyph"}}}]}
            """
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let devices = try await api.fetchTrmnlDevices(siteID: "site 1")
        #expect(devices.count == 1)
        #expect(devices.first?.id == 4)
        #expect(devices.first?.screen.index == 1)
        #expect(devices.first?.screen.count == 3)
        #expect(devices.first?.screen.componentConfig == .fixture())
        #expect(recorded?.httpMethod == "GET")
        #expect(recorded?.url?.path == "/api/site/site 1/trmnl-devices")
        #expect(recorded?.url?.absoluteString.contains("site%201") == true)
    }

    @Test("A revoked session reads as sign-in required, and a malformed answer as invalid")
    func trmnlDevicesFailures() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.signInRequired) { _ = try await api.fetchTrmnlDevices(siteID: "s") }
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 200), Data(#"{"devices":"nope"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) { _ = try await api.fetchTrmnlDevices(siteID: "s") }
    }

    @Test("The Trmnl preview asks the markup route for the site and returns its document")
    func fetchTrmnlPreview() async throws {
        var recorded: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recorded = request
            let json = #"{"markup":"<p/>","document":"<!doctype html><p/>"}"#
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let document = try await api.fetchTrmnlPreview(siteID: "site-1", screen: nil)
        #expect(document == "<!doctype html><p/>")
        #expect(recorded?.url?.path == "/api/trmnl/markup")
        let query = URLComponents(url: try #require(recorded?.url), resolvingAgainstBaseURL: false)?.queryItems
        #expect(query == [URLQueryItem(name: "site_id", value: "site-1")])
    }

    @Test("A preview answer with no document is invalid")
    func trmnlPreviewWithoutDocument() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 200), Data(#"{"markup":"<p/>"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) {
            _ = try await api.fetchTrmnlPreview(siteID: "s", screen: nil)
        }
    }

    @Test("A device's screen is sent as the component config to preview")
    func previewSendsComponentConfig() async throws {
        var recorded: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recorded = request
            return (try Self.fillResponse(request, status: 200), Data(#"{"document":"<p/>"}"#.utf8))
        }
        _ = try await api.fetchTrmnlPreview(siteID: "site-1", screen: .fixture(showEstimatedBill: true))
        let query = URLComponents(url: try #require(recorded?.url), resolvingAgainstBaseURL: false)?.queryItems
        let json = try #require(query?.first { $0.name == "component_config" }?.value)
        let sent = try JSONDecoder().decode(TrmnlComponentConfig.self, from: Data(json.utf8))
        #expect(sent == .fixture(showEstimatedBill: true))
        #expect(query?.first { $0.name == "site_id" }?.value == "site-1")
    }

    @Test("A device's screens are read from the manage route by uuid")
    func fetchTrmnlScreens() async throws {
        var recorded: URLRequest?
        StubURLProtocol.requestHandler = { request in
            recorded = request
            let json = """
            {"site_id":"site-1","plugin_setting_id":9,"carousel_index":1,"component_screens":[
              {"id":"screen-1","name":"Screen 1","componentConfig":{"showLiveGrid":true,"showLiveSolar":true,
              "showLiveBattery":true,"showEnergyChart":false,"showBatterySoc":false,"showEstimatedBill":false,
              "showLoadTiming":false,"batterySocMode":"glyph"}}]}
            """
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let screens = try await api.fetchTrmnlScreens(uuid: "abc-123")
        #expect(screens.map(\.id) == ["screen-1"])
        #expect(screens.first?.componentConfig == .fixture())
        #expect(recorded?.httpMethod == "GET")
        #expect(recorded?.url?.path == "/api/trmnl/manage")
        #expect(URLComponents(url: try #require(recorded?.url), resolvingAgainstBaseURL: false)?.queryItems
            == [URLQueryItem(name: "uuid", value: "abc-123")])
    }

    @Test("A screens answer with none is invalid")
    func fetchTrmnlScreensEmpty() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 200), Data(#"{"component_screens":[]}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) { _ = try await api.fetchTrmnlScreens(uuid: "u") }
    }

    @Test("Saving posts the device, site and screens the way the web app does")
    func saveTrmnlScreens() async throws {
        var recorded: (URLRequest, Data)?
        StubURLProtocol.requestHandler = { request in
            recorded = (request, try Self.bodyData(from: request))
            return (try Self.fillResponse(request, status: 200), Data(#"{"success":true}"#.utf8))
        }
        let device = TrmnlDevice.fixture(id: 1, uuid: "abc-123")
        let screens = [TrmnlManagedScreen(id: "screen-1", name: "Screen 1", componentConfig: .fixture())]
        try await api.saveTrmnlScreens(screens, for: device, siteID: "site-1")

        let (request, body) = try #require(recorded)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/trmnl/manage")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(sent["uuid"] as? String == "abc-123")
        #expect(sent["site_id"] as? String == "site-1")
        #expect(sent["plugin_setting_id"] as? Int == device.pluginSettingId)
        let sentScreens = try #require(sent["component_screens"] as? [[String: Any]])
        #expect(sentScreens.first?["id"] as? String == "screen-1")
        #expect(sentScreens.first?["name"] as? String == "Screen 1")
        #expect((sentScreens.first?["componentConfig"] as? [String: Any])?["batterySocMode"] as? String == "glyph")
    }

    @Test("Saving refuses zero or too many screens before sending anything, and maps a revoked session")
    func saveTrmnlScreensFailures() async throws {
        let device = TrmnlDevice.fixture()
        let one = TrmnlManagedScreen(id: "a", name: "Screen 1", componentConfig: .fixture())
        StubURLProtocol.requestHandler = { _ in
            Issue.record("An invalid save must not reach the network")
            throw URLError(.badServerResponse)
        }
        for screens in [[], [one, one, one, one]] {
            await #expect(throws: PWUsageAPIError.invalidResponse) {
                try await api.saveTrmnlScreens(screens, for: device, siteID: "s")
            }
        }
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.signInRequired) {
            try await api.saveTrmnlScreens([one], for: device, siteID: "s")
        }
    }
}
