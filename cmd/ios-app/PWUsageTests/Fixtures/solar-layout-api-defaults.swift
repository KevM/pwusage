import Foundation
@testable import PWUsage

/// Application API fakes that predate the solar beta behave like a server that has it switched off.
extension PWUsageApplicationAPI {
    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        .disabled
    }
}
