import Foundation

struct MobileSessionExchange: Codable, Equatable {
    let attemptId: String
    let code: String
    let verifier: String
    let state: String
}

enum PWUsageAPIError: Error, Equatable {
    case signInRequired
    case recoverableServerError(statusCode: Int)
    case requestRejected(statusCode: Int, message: String?)
    case invalidResponse
}

protocol MobileAuthAPI: Sendable {
    func exchangeSession(_ exchange: MobileSessionExchange) async throws
    func logout() async throws
    func clearSiteAuthCookie() async
}

final class PWUsageAPI: MobileAuthAPI, Sendable {
    private let origin: URL
    /// Not private so tests can pin the session policy the default initializer builds.
    let session: URLSession

    init(configuration: AppConfiguration, session: URLSession? = nil) {
        origin = configuration.apiOrigin
        if let session {
            self.session = session
        } else {
            let storage = SharedWebSession.cookieStorage()
            SharedWebSession.migrateSession(for: origin, from: .shared, to: storage)
            self.session = SharedWebSession.makeSession(cookieStorage: storage)
        }
    }

    func fetchSites() async throws -> [MobileSite] {
        let data = try await request(path: "/api/sites")
        do { return try MobileContractDecoder.make().decode([MobileSite].self, from: data) }
        catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        let url = try makeURL(path: "/api/site-live-data", siteID: siteID, extra: [URLQueryItem(name: "view", value: "mobile")])
        let data = try await request(url: url)
        do {
            return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: data).validating(siteID: siteID)
        } catch let error as MobileLiveResponse.ContractError { throw error }
        catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse {
        let url = try makeURL(path: "/api/mobile/live-power", siteID: siteID)
        let data = try await request(url: url)
        do {
            return try MobileContractDecoder.make().decode(MobileLivePowerResponse.self, from: data)
                .validating(siteID: siteID)
        } catch let error as MobileLiveResponse.ContractError { throw error } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        let url = try makeURL(path: "/api/mobile/bill-summary", siteID: siteID, extra: [URLQueryItem(name: "outlook", value: "1")])
        let data = try await request(url: url)
        do {
            return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: data).validating(siteID: siteID)
        } catch let error as MobileBillResponse.ContractError { throw error }
        catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchTariffs(siteID: String) async throws -> MobileTariffsResponse {
        let segmentCharacters = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/%?#"))
        guard !siteID.isEmpty,
              let encodedSiteID = siteID.addingPercentEncoding(withAllowedCharacters: segmentCharacters),
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        components.percentEncodedPath = "/api/site/\(encodedSiteID)/refresh-tariffs"
        components.query = nil
        guard let url = components.url else { throw PWUsageAPIError.invalidResponse }
        let data = try await request(url: url)
        do {
            return try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: data).validating(siteID: siteID)
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse {
        let data = try await request(url: makeSiteURL(siteID: siteID, suffix: "battery-hold"))
        do {
            return try MobileContractDecoder.make().decode(BatteryHoldResponse.self, from: data).validating(siteID: siteID)
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult {
        if case .park(let choice) = command, !choice.isValid { throw PWUsageAPIError.invalidResponse }
        var request = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "battery-hold"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(command)
        let data = try await perform(request)
        do {
            return try MobileContractDecoder.make().decode(BatteryHoldCommandResult.self, from: data)
                .validating(siteID: siteID, command: command)
        } catch { throw PWUsageAPIError.invalidResponse }
    }

    func registerBatteryHoldActivity(siteID: String, registration: BatteryHoldActivityRegistration) async throws {
        var request = URLRequest(url: try makeSiteURL(siteID: siteID, suffix: "battery-hold/activities"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(registration)
        _ = try await perform(request)
    }

    func unregisterBatteryHoldActivity(siteID: String, registrationID: UUID) async throws {
        let url = try makeSiteURL(siteID: siteID, suffix: "battery-hold/activities")
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw PWUsageAPIError.invalidResponse }
        components.queryItems = [URLQueryItem(name: "registrationId", value: registrationID.uuidString.lowercased())]
        guard let deleteURL = components.url else { throw PWUsageAPIError.invalidResponse }
        var request = URLRequest(url: deleteURL)
        request.httpMethod = "DELETE"
        _ = try await perform(request)
    }

    private func makeSiteURL(siteID: String, suffix: String) throws -> URL {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/%?#"))
        guard !siteID.isEmpty, let encodedID = siteID.addingPercentEncoding(withAllowedCharacters: allowed),
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        components.percentEncodedPath = "/api/site/\(encodedID)/\(suffix)"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw PWUsageAPIError.invalidResponse }
        return url
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        let url = try makeURL(path: "/api/mobile/load-planning-context", siteID: siteID)
        let data = try await request(url: url)
        do {
            return try MobileContractDecoder.make().decode(MobileLoadPlanningContextResponse.self, from: data)
        } catch let error as MobileLoadPlanningContextResponse.ContractError { throw error }
        catch { throw PWUsageAPIError.invalidResponse }
    }

    func fetchSolarHistory(
        siteID: String,
        from: String,
        changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        var items = [URLQueryItem(name: "from", value: from)]
        if let changedSince {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            items.append(URLQueryItem(name: "changedSince", value: formatter.string(from: changedSince)))
        }
        let data = try await request(url: makeURL(path: "/api/mobile/solar-history", siteID: siteID, extra: items))
        do { return try MobileContractDecoder.make().decode(MobileSolarHistoryResponse.self, from: data) } catch {
            throw PWUsageAPIError.invalidResponse
        }
    }

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {
        let url = try makeURL(path: "/api/mobile/session")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(exchange)
        let data = try await perform(request)
        guard (try? JSONDecoder().decode(SessionResponse.self, from: data).ok) == true else {
            throw PWUsageAPIError.invalidResponse
        }
    }

    func logout() async throws {
        let url = try makeURL(path: "/logout")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try await perform(request)
    }

    func clearSiteAuthCookie() async {
        let cookieStorage = session.configuration.httpCookieStorage ?? .shared
        guard let cookies = cookieStorage.cookies(for: origin) else { return }
        for cookie in cookies where cookie.name == "site_auth" {
            cookieStorage.deleteCookie(cookie)
        }
    }

    private func request(path: String) async throws -> Data {
        try await request(url: makeURL(path: path))
    }

    private func request(url: URL) async throws -> Data {
        try await perform(URLRequest(url: url))
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw PWUsageAPIError.invalidResponse }
        guard (200 ..< 300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw PWUsageAPIError.signInRequired }
            if (500 ..< 600).contains(http.statusCode) {
                throw PWUsageAPIError.recoverableServerError(statusCode: http.statusCode)
            }
            let failure = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            let message = failure?.code == "TESLA_CONNECTION_REQUIRED" ? failure?.code : failure?.error
            throw PWUsageAPIError.requestRejected(statusCode: http.statusCode, message: message)
        }
        return data
    }

    private func makeURL(path: String, siteID: String? = nil, extra: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw PWUsageAPIError.invalidResponse
        }
        components.path = path
        var items = extra
        if let siteID { items.append(URLQueryItem(name: "siteId", value: siteID)) }
        components.queryItems = items.isEmpty ? nil : items
        guard let url = components.url else { throw PWUsageAPIError.invalidResponse }
        return url
    }

    private struct SessionResponse: Decodable { let ok: Bool }
    private struct ErrorResponse: Decodable { let error: String?; let code: String? }
}

// Every retroactive conformance this type has, in one place. Each protocol is
// declared next to the type that consumes it, which is why these used to be one
// line each in three files.
extension PWUsageAPI: MobileDashboardDataAPI, MobileLivePowerDataAPI {}
extension PWUsageAPI: MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI {}
extension PWUsageAPI: PWUsageApplicationAPI {}

extension PWUsageAPI: MobileTariffDataAPI {}
extension PWUsageAPI: MobileBatteryHoldDataAPI {}
extension PWUsageAPI: BatteryHoldActivityAPI {}
