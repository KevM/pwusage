import Foundation
import Observation

/// The Trmnl screen's devices. One device at a time is edited (see `TrmnlScreensEditorModel`); a site with
/// none shows the default screen as a preview of what a device would get.
@MainActor
@Observable
final class TrmnlSettingsModel {
    enum Devices: Equatable {
        case loading
        case loaded([TrmnlDevice])
        case failed
    }

    private(set) var devices = Devices.loading
    /// The device being edited; nil until devices load, and when there are none.
    var selectedDeviceID: Int?
    private(set) var defaultPreview = TrmnlPreviewState.loading

    private let siteID: String
    private let api: any MobileTrmnlAPI

    init(siteID: String, api: any MobileTrmnlAPI) {
        self.siteID = siteID
        self.api = api
    }

    var selectedDevice: TrmnlDevice? {
        guard case .loaded(let devices) = devices else { return nil }
        return devices.first { $0.id == selectedDeviceID }
    }

    /// How many devices are connected, for the Settings row; nil until some are, so the row stays quiet
    /// while loading, on a failure and for a site with none.
    var connectedDeviceCount: Int? {
        guard case .loaded(let devices) = devices, !devices.isEmpty else { return nil }
        return devices.count
    }

    func makeEditor(for device: TrmnlDevice) -> TrmnlScreensEditorModel {
        TrmnlScreensEditorModel(device: device, siteID: siteID, api: api)
    }

    /// Loads everything afresh, as on opening the screen or pulling to refresh.
    func load() async {
        await reloadDevices()
        if case .loaded(let devices) = devices, devices.isEmpty { await loadDefaultPreview() }
    }

    /// Fetches the devices again, for when a person comes back from adding one on trmnl.com. A
    /// failure keeps the list already shown; only a first load can fail.
    func reloadDevices() async {
        do {
            let loaded = try await api.fetchTrmnlDevices(siteID: siteID)
            devices = .loaded(loaded)
            if !loaded.contains(where: { $0.id == selectedDeviceID }) { selectedDeviceID = loaded.first?.id }
        } catch {
            guard !Task.isCancelled, case .loading = devices else { return }
            devices = .failed
        }
    }

    func loadDefaultPreview() async {
        do {
            defaultPreview = try await .ready(document: api.fetchTrmnlPreview(siteID: siteID, screen: nil))
        } catch {
            defaultPreview = Task.isCancelled ? .loading : .unavailable
        }
    }
}
