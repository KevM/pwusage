import Foundation

/// A Trmnl device that finished connecting to a site.
struct TrmnlDevice: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let uuid: String
    /// The device's plugin on trmnl.com, which `Open in Trmnl` links to.
    let pluginSettingId: Int
    /// Nil when the server could not date the install.
    let connectedAt: Date?
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
    /// The HTML document of the site's Trmnl screen.
    func fetchTrmnlPreview(siteID: String) async throws -> String
}
