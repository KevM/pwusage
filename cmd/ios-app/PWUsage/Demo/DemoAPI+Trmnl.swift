import Foundation

/// Demo has no connected Trmnl devices, so Settings > Trmnl shows the intro screen
/// with a local preview of what Cedar House's default screen would look like.
extension DemoAPI {
    func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] { [] }

    func fetchTrmnlPreview(siteID _: String, screen _: TrmnlComponentConfig?) async throws -> String {
        DemoTrmnlPreview.defaultDocument
    }

    func fetchTrmnlScreens(uuid _: String) async throws -> [TrmnlManagedScreen] {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo has no Trmnl")
    }

    func saveTrmnlScreens(_: [TrmnlManagedScreen], for _: TrmnlDevice, siteID _: String) async throws {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo is read-only")
    }
}
