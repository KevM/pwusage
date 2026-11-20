import Foundation

/// Demo sends nothing to Tesla, so Sync to Tesla is always unavailable here.
extension DemoAPI: MobileTeslaSyncAPI {
    private static let unavailable = TeslaSyncUnavailability(
        reason: "tesla_unavailable", message: "Sync to Tesla isn't available in the demo."
    )

    func previewTeslaSync(siteID _: String) async throws -> TeslaSyncPreviewDTO {
        throw Self.unavailable
    }

    func commitTeslaSync(siteID _: String, fingerprint _: String) async throws -> TeslaSyncResultDTO {
        throw Self.unavailable
    }
}
