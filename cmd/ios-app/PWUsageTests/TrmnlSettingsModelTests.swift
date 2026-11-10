import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Trmnl settings model")
struct TrmnlSettingsModelTests {
    private let first = TrmnlDevice.fixture(id: 1)
    private let second = TrmnlDevice.fixture(id: 2, uuid: "12345678-0000")

    @Test("The first device is selected once devices load")
    func selectsFirstDevice() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        let model = TrmnlSettingsModel(siteID: "site-1", api: api)
        #expect(model.devices == .loading)
        await model.load()
        #expect(model.devices == .loaded([first, second]))
        #expect(model.selectedDeviceID == 1)
        #expect(model.selectedDevice == first)
        #expect(api.previewRequests.isEmpty)
    }

    @Test("With no devices the site's default screen is previewed")
    func noDevicesPreviewsSite() async {
        let api = FakeTrmnlAPI(devices: .success([]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.selectedDeviceID == nil)
        #expect(model.defaultPreview == .ready(document: "<doc/>"))
        #expect(api.previewRequests == [.init(siteID: "s", screen: nil)])
    }

    @Test("Devices that fail to load say so, and a later failure keeps the list")
    func deviceFailure() async {
        let api = FakeTrmnlAPI(devices: .failure(URLError(.notConnectedToInternet)))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.devices == .failed)

        api.devices = .success([first])
        await model.reloadDevices()
        #expect(model.devices == .loaded([first]))

        api.devices = .failure(URLError(.timedOut))
        await model.reloadDevices()
        #expect(model.devices == .loaded([first]))
    }

    @Test("A removed selection falls back to the first device")
    func reloadKeepsSelectionValid() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        model.selectedDeviceID = 2
        api.devices = .success([first])
        await model.reloadDevices()
        #expect(model.selectedDeviceID == 1)
    }

    @Test("The Settings row has a device count only once one is connected")
    func connectedDeviceCount() async {
        let api = FakeTrmnlAPI(devices: .success([]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        #expect(model.connectedDeviceCount == nil)
        await model.reloadDevices()
        #expect(model.connectedDeviceCount == nil)
        api.devices = .success([first, second])
        await model.reloadDevices()
        #expect(model.connectedDeviceCount == 2)
        api.devices = .failure(URLError(.timedOut))
        await model.reloadDevices()
        #expect(model.connectedDeviceCount == 2)
        #expect(api.previewRequests.isEmpty)
    }

    @Test("An editor is made for a device on the same site")
    func makesEditor() {
        let model = TrmnlSettingsModel(siteID: "s", api: FakeTrmnlAPI(devices: .success([])))
        #expect(model.makeEditor(for: first).device == first)
    }
}

private final class FakeTrmnlAPI: MobileTrmnlAPI, @unchecked Sendable {
    struct PreviewRequest: Equatable {
        let siteID: String
        let screen: TrmnlComponentConfig?
    }

    var devices: Result<[TrmnlDevice], any Error>
    private(set) var previewRequests: [PreviewRequest] = []

    init(devices: Result<[TrmnlDevice], any Error>) {
        self.devices = devices
    }

    func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] {
        try devices.get()
    }

    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String {
        previewRequests.append(PreviewRequest(siteID: siteID, screen: screen))
        return "<doc/>"
    }

    func fetchTrmnlScreens(uuid _: String) async throws -> [TrmnlManagedScreen] { [] }

    func saveTrmnlScreens(_: [TrmnlManagedScreen], for _: TrmnlDevice, siteID _: String) async throws {}
}
