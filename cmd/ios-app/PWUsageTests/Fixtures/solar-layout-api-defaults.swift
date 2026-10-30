@testable import PWUsage

/// Application API fakes that predate the solar beta behave like a server that has it switched off.
extension PWUsageApplicationAPI {
    func fetchSolarLayout(siteID: String) async throws -> MobileSolarLayoutResponse { .disabled }
    func postSolarLocation(siteID: String, latitude: Double, longitude: Double) async throws {}
    func fetchSolarActuals(siteID: String) async throws -> MobileSolarActualsResponse { .disabled }
}
