import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Trmnl settings model")
struct TrmnlSettingsModelTests {
    private let device = TrmnlDevice(id: 1, uuid: "abcdef12-0000", pluginSettingId: 5, connectedAt: nil)

    @Test("Devices and the preview load independently")
    func loadsBoth() async {
        let api = FakeTrmnlAPI(devices: .success([device]), preview: .success("<html/>"))
        let model = TrmnlSettingsModel(siteID: "site-1", api: api)
        #expect(model.devices == .loading)
        #expect(model.preview == .loading)
        await model.load()
        #expect(model.devices == .loaded([device]))
        #expect(model.preview == .ready(document: "<html/>"))
        #expect(api.requestedSiteIDs == ["site-1", "site-1"])
    }

    @Test("A failed preview leaves the devices showing")
    func previewFailureKeepsDevices() async {
        let model = TrmnlSettingsModel(
            siteID: "s", api: FakeTrmnlAPI(devices: .success([device]), preview: .failure(URLError(.timedOut))))
        await model.load()
        #expect(model.devices == .loaded([device]))
        #expect(model.preview == .unavailable)
    }

    @Test("A first load that fails says so, and a later failure keeps the list")
    func deviceFailure() async {
        let api = FakeTrmnlAPI(devices: .failure(URLError(.notConnectedToInternet)), preview: .success("<html/>"))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.devices == .failed)

        api.devices = .success([device])
        await model.reloadDevices()
        #expect(model.devices == .loaded([device]))

        api.devices = .failure(URLError(.timedOut))
        await model.reloadDevices()
        #expect(model.devices == .loaded([device]))
    }

    @Test("Coming back from trmnl.com picks up a newly connected device")
    func reloadPicksUpNewDevice() async {
        let api = FakeTrmnlAPI(devices: .success([]), preview: .success("<html/>"))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.devices == .loaded([]))
        api.devices = .success([device])
        await model.reloadDevices()
        #expect(model.devices == .loaded([device]))
    }
}

private final class FakeTrmnlAPI: MobileTrmnlAPI, @unchecked Sendable {
    var devices: Result<[TrmnlDevice], any Error>
    var preview: Result<String, any Error>
    private(set) var requestedSiteIDs: [String] = []

    init(devices: Result<[TrmnlDevice], any Error>, preview: Result<String, any Error>) {
        self.devices = devices
        self.preview = preview
    }

    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] {
        requestedSiteIDs.append(siteID)
        return try devices.get()
    }

    func fetchTrmnlPreview(siteID: String) async throws -> String {
        requestedSiteIDs.append(siteID)
        return try preview.get()
    }
}
