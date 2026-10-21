import Foundation

enum SharedWebSession {
    static func cookieStorage() -> HTTPCookieStorage {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PWUSAGE_APP_GROUP") as? String,
              !group.isEmpty else { return .shared }
        return .sharedCookieStorage(forGroupContainerIdentifier: group)
    }

    /// Move the pre-widget session, then remove the old copy so logout cannot resurrect it.
    /// The server issues persistent cookies, which can be shared across processes.
    static func migrateSession(for origin: URL, from legacy: HTTPCookieStorage, to shared: HTTPCookieStorage) {
        guard legacy !== shared else { return }
        for cookie in legacy.cookies(for: origin) ?? [] where cookie.name == "site_auth" {
            if !(shared.cookies(for: origin) ?? []).contains(where: { $0.name == "site_auth" }),
               let expiry = cookie.expiresDate, expiry > Date() {
                shared.setCookie(cookie)
            }
            legacy.deleteCookie(cookie)
        }
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = cookieStorage()
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        return URLSession(configuration: configuration)
    }
}
