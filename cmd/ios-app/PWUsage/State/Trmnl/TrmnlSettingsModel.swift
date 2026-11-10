import Foundation
import Observation

/// What the Trmnl screen shows: the site's devices, and a preview of the screen each one is on. Devices
/// load first because the previews are of their screens; a preview that is slow or fails never hides
/// the devices, and each device's preview loads only once a person lands on it.
@MainActor
@Observable
final class TrmnlSettingsModel {
    enum Devices: Equatable {
        case loading
        case loaded([TrmnlDevice])
        case failed
    }

    enum Preview: Equatable {
        case loading
        case ready(document: String)
        case unavailable
    }

    private(set) var devices = Devices.loading
    /// The device whose preview is showing; nil until devices load, and when there are none.
    var selectedDeviceID: Int?

    private var previews: [PreviewKey: Preview] = [:]
    private let siteID: String
    private let api: any MobileTrmnlAPI

    /// A device's own screen, or the site's default screen when no device is connected.
    private enum PreviewKey: Hashable {
        case site
        case device(Int)
    }

    init(siteID: String, api: any MobileTrmnlAPI) {
        self.siteID = siteID
        self.api = api
    }

    var selectedDevice: TrmnlDevice? {
        guard case .loaded(let devices) = devices else { return nil }
        return devices.first { $0.id == selectedDeviceID }
    }

    /// The preview for `device`, or for the site's default screen when nil.
    func preview(for device: TrmnlDevice?) -> Preview {
        previews[Self.key(for: device)] ?? .loading
    }

    /// Loads everything afresh, as on opening the screen or pulling to refresh.
    func load() async {
        previews = [:]
        await reloadDevices()
        await loadSelectedPreview()
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

    func loadSelectedPreview() async {
        await loadPreview(for: selectedDevice)
    }

    private func loadPreview(for device: TrmnlDevice?) async {
        let key = Self.key(for: device)
        if case .ready = previews[key] { return }
        do {
            previews[key] = .loading
            previews[key] = try await .ready(document: api.fetchTrmnlPreview(
                siteID: siteID, screen: device?.screen.componentConfig))
        } catch {
            // A page swiped away mid-load starts again when it comes back.
            previews[key] = Task.isCancelled ? nil : .unavailable
        }
    }

    private static func key(for device: TrmnlDevice?) -> PreviewKey {
        device.map { .device($0.id) } ?? .site
    }
}
