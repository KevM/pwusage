import Foundation
@testable import PWUsage
import Testing

@Suite("Trmnl presentation")
struct TrmnlPresentationTests {
    private let device = TrmnlDevice(
        id: 2, uuid: "abcdef12-0000-4000-8000-000000000000", pluginSettingId: 77,
        connectedAt: Date(timeIntervalSince1970: 1_793_718_000))

    @Test("A device is named by the start of its uuid and dated in UTC")
    func nameAndDate() {
        #expect(TrmnlPresentation.name(for: device) == "Device abcdef12")
        let label = TrmnlPresentation.connectedLabel(for: device, locale: Locale(identifier: "en_US"))
        #expect(label == "Connected Nov 3, 2026")
        let undated = TrmnlDevice(id: 1, uuid: "x", pluginSettingId: 1, connectedAt: nil)
        #expect(TrmnlPresentation.connectedLabel(for: undated) == nil)
    }

    @Test("Links open the plugin on trmnl.com and the web app's screens page")
    func links() throws {
        #expect(TrmnlPresentation.openURL(for: device).absoluteString == "https://trmnl.com/plugin_settings/77/edit")
        #expect(TrmnlPresentation.addURL.absoluteString
            == "https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage")
        let origin = try #require(URL(string: "https://pwusage.example"))
        #expect(TrmnlPresentation.screensURL(origin: origin, device: device).absoluteString
            == "https://pwusage.example/trmnl/manage?uuid=abcdef12-0000-4000-8000-000000000000")
    }

    @Test("The add button offers another device once one is connected")
    func addButton() {
        #expect(TrmnlPresentation.addButtonTitle(deviceCount: 0) == "Add Trmnl")
        #expect(TrmnlPresentation.addButtonTitle(deviceCount: 1) == "Add another device")
    }

    @Test("Copy follows the voice guide: plain, calm, no exclamation marks or please")
    func copyIsCalm() {
        let strings = [
            TrmnlPresentation.previewUnavailable, TrmnlPresentation.devicesFailure,
            TrmnlPresentation.emptyTitle, TrmnlPresentation.emptyMessage
        ]
        for string in strings {
            #expect(!string.contains("!"))
            #expect(!string.lowercased().contains("please"))
            #expect(!string.lowercased().contains("sorry"))
        }
    }
}
