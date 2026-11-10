import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Trmnl settings model")
struct TrmnlSettingsModelTests {
    private let first = TrmnlDevice.fixture(id: 1)
    private let second = TrmnlDevice.fixture(id: 2, uuid: "12345678-0000", showEstimatedBill: true)

    @Test("The first device is selected and its screen is previewed")
    func previewsFirstDevice() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        let model = TrmnlSettingsModel(siteID: "site-1", api: api)
        #expect(model.devices == .loading)
        await model.load()
        #expect(model.devices == .loaded([first, second]))
        #expect(model.selectedDeviceID == 1)
        #expect(model.preview(for: first) == .ready(document: "<doc/>"))
        #expect(model.preview(for: second) == .loading)
        #expect(api.previewRequests == [.init(siteID: "site-1", screen: first.screen.componentConfig)])
    }

    @Test("Swiping to another device previews its screen once")
    func selectingLoadsOnce() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        model.selectedDeviceID = 2
        await model.loadSelectedPreview()
        await model.loadSelectedPreview()
        #expect(model.preview(for: second) == .ready(document: "<doc/>"))
        #expect(api.previewRequests.map(\.screen) == [first.screen.componentConfig, second.screen.componentConfig])
    }

    @Test("With no devices the site's default screen is previewed")
    func noDevicesPreviewsSite() async {
        let api = FakeTrmnlAPI(devices: .success([]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.selectedDeviceID == nil)
        #expect(model.preview(for: nil) == .ready(document: "<doc/>"))
        #expect(api.previewRequests == [.init(siteID: "s", screen: nil)])
    }

    @Test("Devices that fail to load still leave the site preview")
    func deviceFailure() async {
        let api = FakeTrmnlAPI(devices: .failure(URLError(.notConnectedToInternet)))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        #expect(model.devices == .failed)
        #expect(model.preview(for: nil) == .ready(document: "<doc/>"))

        api.devices = .success([first])
        await model.reloadDevices()
        #expect(model.devices == .loaded([first]))

        api.devices = .failure(URLError(.timedOut))
        await model.reloadDevices()
        #expect(model.devices == .loaded([first]))
    }

    @Test("A failed preview marks only that page unavailable")
    func previewFailureIsPerPage() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        api.previewFailures = [second.screen.componentConfig]
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        model.selectedDeviceID = 2
        await model.loadSelectedPreview()
        #expect(model.devices == .loaded([first, second]))
        #expect(model.preview(for: first) == .ready(document: "<doc/>"))
        #expect(model.preview(for: second) == .unavailable)
    }

    @Test("Coming back from trmnl.com picks up a new device, and a removed selection falls back to the first")
    func reloadKeepsSelectionValid() async {
        let api = FakeTrmnlAPI(devices: .success([first, second]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        model.selectedDeviceID = 2
        api.devices = .success([first])
        await model.reloadDevices()
        #expect(model.selectedDeviceID == 1)
    }

    @Test("Pulling to refresh fetches the previews again")
    func refreshRefetches() async {
        let api = FakeTrmnlAPI(devices: .success([first]))
        let model = TrmnlSettingsModel(siteID: "s", api: api)
        await model.load()
        await model.load()
        #expect(api.previewRequests.count == 2)
    }
}

private final class FakeTrmnlAPI: MobileTrmnlAPI, @unchecked Sendable {
    struct PreviewRequest: Equatable {
        let siteID: String
        let screen: TrmnlComponentConfig?
    }

    var devices: Result<[TrmnlDevice], any Error>
    var previewFailures: [TrmnlComponentConfig] = []
    private(set) var previewRequests: [PreviewRequest] = []

    init(devices: Result<[TrmnlDevice], any Error>) {
        self.devices = devices
    }

    func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] {
        try devices.get()
    }

    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String {
        previewRequests.append(PreviewRequest(siteID: siteID, screen: screen))
        if let screen, previewFailures.contains(screen) { throw URLError(.timedOut) }
        return "<doc/>"
    }
}
