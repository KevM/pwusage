import Foundation
@testable import PWUsage
import Testing

@Suite("Trmnl presentation")
struct TrmnlPresentationTests {
    private let device = TrmnlDevice(
        id: 2, uuid: "abcdef12-0000-4000-8000-000000000000", pluginSettingId: 77,
        connectedAt: Date(timeIntervalSince1970: 1_793_718_000),
        screen: TrmnlDevice.fixture().screen)

    @Test("A device is named by the start of its uuid and dated in UTC")
    func nameAndDate() {
        #expect(TrmnlPresentation.name(for: device) == "Device abcdef12")
        let label = TrmnlPresentation.connectedLabel(for: device, locale: Locale(identifier: "en_US"))
        #expect(label == "Connected Nov 3, 2026")
        let undated = TrmnlDevice.fixture(id: 1, uuid: "x")
        #expect(TrmnlPresentation.connectedLabel(for: undated) == nil)
    }

    @Test("The caption says where the screen is in the rotation, and when it is the one on the device")
    func screenCaption() {
        #expect(TrmnlPresentation.screenCaption(index: 1, count: 3, isShowingNow: false) == "Screen 2 of 3")
        #expect(TrmnlPresentation.screenCaption(index: 0, count: 2, isShowingNow: true)
            == "Screen 1 of 2 · On the device now")
        #expect(TrmnlPresentation.deleteConfirmation(screenName: "Screen 2")
            == "Delete Screen 2? This cannot be undone.")
    }

    @Test("The Settings row counts devices")
    func deviceCountLabel() {
        #expect(TrmnlPresentation.deviceCountLabel(1) == "1 device")
        #expect(TrmnlPresentation.deviceCountLabel(3) == "3 devices")
    }

    @Test("The caption names the device and, when it rotates, the screen it is on")
    func caption() {
        let rotating = TrmnlDevice.fixture(screenIndex: 1, screenCount: 3)
        #expect(TrmnlPresentation.caption(for: rotating) == "Device abcdef12 · Screen 2 of 3")
        #expect(TrmnlPresentation.caption(for: .fixture()) == "Device abcdef12")
    }

    @Test("Links open the plugin on trmnl.com")
    func links() {
        #expect(TrmnlPresentation.openURL(for: device).absoluteString == "https://trmnl.com/plugin_settings/77/edit")
        #expect(TrmnlPresentation.addURL.absoluteString
            == "https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage")
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
            TrmnlPresentation.saveFailure, TrmnlPresentation.screensLoadFailure,
            TrmnlPresentation.emptyTitle, TrmnlPresentation.emptyMessage
        ]
        for string in strings {
            #expect(!string.contains("!"))
            #expect(!string.lowercased().contains("please"))
            #expect(!string.lowercased().contains("sorry"))
        }
    }
}
