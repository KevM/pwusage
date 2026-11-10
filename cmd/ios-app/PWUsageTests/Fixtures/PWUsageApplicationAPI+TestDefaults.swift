import Foundation
@testable import PWUsage

/// Application API fakes that predate the solar beta behave like a server that has it switched off.
extension PWUsageApplicationAPI {
    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        .disabled
    }

    /// Fakes that predate the billing day have no server to save it to.
    func setBillingDay(siteID: String, day: Int) async throws -> MobileBillingDay {
        throw PWUsageAPIError.invalidResponse
    }
}

extension PWUsageApplicationAPI {
    /// Fakes that predate Trmnl management have no devices to list.
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] { [] }

    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String {
        throw PWUsageAPIError.invalidResponse
    }
}
