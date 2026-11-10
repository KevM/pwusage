import Foundation
import Observation

/// What the Trmnl screen shows: the site's devices and a preview of its screen. The two load
/// independently, so a slow or failed preview never hides the devices.
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
    private(set) var preview = Preview.loading

    private let siteID: String
    private let api: any MobileTrmnlAPI

    init(siteID: String, api: any MobileTrmnlAPI) {
        self.siteID = siteID
        self.api = api
    }

    func load() async {
        async let devicesLoad: Void = reloadDevices()
        async let previewLoad: Void = reloadPreview()
        _ = await (devicesLoad, previewLoad)
    }

    /// Fetches the devices again, for when a person comes back from adding one on trmnl.com. A
    /// failure keeps the list already shown; only a first load can fail.
    func reloadDevices() async {
        do {
            devices = try await .loaded(api.fetchTrmnlDevices(siteID: siteID))
        } catch {
            guard !Task.isCancelled, case .loading = devices else { return }
            devices = .failed
        }
    }

    func reloadPreview() async {
        do {
            preview = try await .ready(document: api.fetchTrmnlPreview(siteID: siteID))
        } catch {
            guard !Task.isCancelled else { return }
            preview = .unavailable
        }
    }
}
