import Foundation

/// Which parts of the site's data a Trmnl screen shows. Sent back unchanged to preview the screen.
struct TrmnlComponentConfig: Codable, Hashable, Sendable {
    var showLiveGrid: Bool
    var showLiveSolar: Bool
    var showLiveBattery: Bool
    var showEnergyChart: Bool
    var showBatterySoc: Bool
    var showEstimatedBill: Bool
    var showLoadTiming: Bool
    /// "glyph" or "chart".
    var batterySocMode: String

    /// What a new screen starts as, matching the web editor.
    static let newScreen = TrmnlComponentConfig(
        showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true,
        showBatterySoc: true, showEstimatedBill: false, showLoadTiming: false, batterySocMode: "chart")
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

/// One of the screens a device rotates through, as the web app stores it.
struct TrmnlManagedScreen: Codable, Equatable, Identifiable, Sendable {
    let id: String
    /// Always "Screen 1", "Screen 2" and so on by position.
    var name: String
    var componentConfig: TrmnlComponentConfig

    /// The most screens a device holds.
    static let maxScreens = 3
}

/// The screens page's answer for a device.
struct TrmnlManagedScreensResponse: Decodable, Equatable, Sendable {
    let screens: [TrmnlManagedScreen]

    private enum CodingKeys: String, CodingKey { case screens = "component_screens" }
}

protocol MobileTrmnlAPI: Sendable {
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice]
    /// The HTML document of a Trmnl screen for the site: the one `screen` describes, or the default when nil.
    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String
    /// The screens a device rotates through, in order.
    func fetchTrmnlScreens(uuid: String) async throws -> [TrmnlManagedScreen]
    /// Replaces the device's screens; one to three, in rotation order.
    func saveTrmnlScreens(_ screens: [TrmnlManagedScreen], for device: TrmnlDevice, siteID: String) async throws
}
