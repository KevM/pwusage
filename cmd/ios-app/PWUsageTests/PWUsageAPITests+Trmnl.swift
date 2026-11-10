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
}
