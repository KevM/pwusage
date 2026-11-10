import Foundation

/// Which parts of the site's data a Trmnl screen shows. Sent back unchanged to preview the screen.
struct TrmnlComponentConfig: Codable, Equatable, Sendable {
    let showLiveGrid: Bool
    let showLiveSolar: Bool
    let showLiveBattery: Bool
    let showEnergyChart: Bool
    let showBatterySoc: Bool
    let showEstimatedBill: Bool
    let showLoadTiming: Bool
    let batterySocMode: String
}

/// The screen a device last fetched, out of the screens it rotates through.
struct TrmnlScreen: Codable, Equatable, Sendable {
    let name: String
    /// Zero-based position in the rotation.
    let index: Int
    let count: Int
    let componentConfig: TrmnlComponentConfig
}

/// A Trmnl device that finished connecting to a site.
struct TrmnlDevice: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let uuid: String
    /// The device's plugin on trmnl.com, which `Open in Trmnl` links to.
    let pluginSettingId: Int
    /// Nil when the server could not date the install.
    let connectedAt: Date?
    let screen: TrmnlScreen
}

struct TrmnlDevicesResponse: Decodable, Equatable, Sendable {
    let devices: [TrmnlDevice]
}

/// The site preview answer. `document` is a self-contained page the app renders as it is; a server that
/// predates it leaves it out.
struct TrmnlPreviewResponse: Decodable, Equatable, Sendable {
    let document: String?
}

protocol MobileTrmnlAPI: Sendable {
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice]
    /// The HTML document of a Trmnl screen for the site: the one `screen` describes, or the default when nil.
    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String
}
