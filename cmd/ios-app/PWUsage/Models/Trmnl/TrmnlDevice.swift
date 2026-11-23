import Foundation
import PWUsageCore

protocol MobileTrmnlAPI: Sendable {
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice]
    /// The HTML document of a Trmnl screen for the site: the one `screen` describes, or the default when nil.
    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String
    /// The screens a device rotates through, in order.
    func fetchTrmnlScreens(uuid: String) async throws -> [TrmnlManagedScreen]
    /// Replaces the device's screens; one to three, in rotation order.
    func saveTrmnlScreens(_ screens: [TrmnlManagedScreen], for device: TrmnlDevice, siteID: String) async throws
}
