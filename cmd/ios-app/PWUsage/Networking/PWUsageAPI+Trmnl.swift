import Foundation

extension PWUsageAPI {
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "trmnl-devices"))
        do {
            return try MobileContractDecoder.make().decode(TrmnlDevicesResponse.self, from: data).devices
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchTrmnlPreview(siteID: String) async throws -> String {
        guard !siteID.isEmpty else { throw PWUsageAPIError.invalidResponse }
        let url = try makeURL(path: "/api/trmnl/markup", extra: [URLQueryItem(name: "site_id", value: siteID)])
        let data = try await request(url: url)
        do {
            guard let document = try JSONDecoder().decode(TrmnlPreviewResponse.self, from: data).document else {
                throw PWUsageAPIError.invalidResponse
            }
            return document
        } catch { throw PWUsageAPIError.invalidResponse }
    }
}
