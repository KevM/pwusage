import Foundation

extension PWUsageAPI {
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "trmnl-devices"))
        do {
            return try MobileContractDecoder.make().decode(TrmnlDevicesResponse.self, from: data).devices
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String {
        guard !siteID.isEmpty else { throw PWUsageAPIError.invalidResponse }
        var query = [URLQueryItem(name: "site_id", value: siteID)]
        if let screen {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            guard let json = try? String(data: encoder.encode(screen), encoding: .utf8) else {
                throw PWUsageAPIError.invalidResponse
            }
            query.append(URLQueryItem(name: "component_config", value: json))
        }
        let url = try makeURL(path: "/api/trmnl/markup", extra: query)
        let data = try await request(url: url)
        do {
            guard let document = try JSONDecoder().decode(TrmnlPreviewResponse.self, from: data).document else {
                throw PWUsageAPIError.invalidResponse
            }
            return document
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchTrmnlScreens(uuid: String) async throws -> [TrmnlManagedScreen] {
        guard !uuid.isEmpty else { throw PWUsageAPIError.invalidResponse }
        let url = try makeURL(path: "/api/trmnl/manage", extra: [URLQueryItem(name: "uuid", value: uuid)])
        let data = try await request(url: url)
        do {
            let screens = try JSONDecoder().decode(TrmnlManagedScreensResponse.self, from: data).screens
            guard !screens.isEmpty else { throw PWUsageAPIError.invalidResponse }
            return screens
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func saveTrmnlScreens(_ screens: [TrmnlManagedScreen], for device: TrmnlDevice, siteID: String) async throws {
        guard (1 ... TrmnlManagedScreen.maxScreens).contains(screens.count), !siteID.isEmpty else {
            throw PWUsageAPIError.invalidResponse
        }
        var request = URLRequest(url: try makeURL(path: "/api/trmnl/manage"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(TrmnlScreensSave(
            uuid: device.uuid, siteID: siteID, pluginSettingID: device.pluginSettingId, screens: screens))
        let data = try await perform(request)
        guard (try? JSONDecoder().decode(TrmnlSaveResponse.self, from: data).success) == true else {
            throw PWUsageAPIError.invalidResponse
        }
    }
}

/// The body the web app's screens page saves with.
private struct TrmnlScreensSave: Encodable {
    let uuid: String
    let siteID: String
    let pluginSettingID: Int
    let screens: [TrmnlManagedScreen]

    private enum CodingKeys: String, CodingKey {
        case uuid
        case siteID = "site_id"
        case pluginSettingID = "plugin_setting_id"
        case screens = "component_screens"
    }
}

private struct TrmnlSaveResponse: Decodable { let success: Bool }
