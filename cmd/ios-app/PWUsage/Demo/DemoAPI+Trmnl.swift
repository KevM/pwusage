import Foundation
import PWUsageCore

/// Demo has no connected Trmnl devices, so Settings > Trmnl shows the intro screen
/// with a preview rendered against the real TRMNL framework stylesheet.
extension DemoAPI {
    func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] { [] }

    func fetchTrmnlPreview(siteID _: String, screen _: TrmnlComponentConfig?) async throws -> String {
        let source = currentSource()
        let bill = try DemoFixtures.bill(asOf: source, billingDay: billingDayOverride)
        return DemoTrmnlPreview.document(bill: bill, asOf: source)
    }

    func fetchTrmnlScreens(uuid _: String) async throws -> [TrmnlManagedScreen] {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo has no Trmnl")
    }

    func saveTrmnlScreens(_: [TrmnlManagedScreen], for _: TrmnlDevice, siteID _: String) async throws {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo is read-only")
    }
}
