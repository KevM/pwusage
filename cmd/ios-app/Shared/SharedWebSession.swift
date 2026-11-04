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

    /// Delete every `site_auth` cookie, regardless of domain or path. Used only for
    /// a fresh install so a session left in the shared jar by a previous install is
    /// not adopted.
    static func clearSessionCookies(in storage: HTTPCookieStorage = cookieStorage()) {
        for cookie in storage.cookies ?? [] where cookie.name == "site_auth" {
            storage.deleteCookie(cookie)
        }
    }

    /// The one policy for authenticated PWUsage requests, app and widget alike: bounded
    /// timeouts, and no URL cache, so no authenticated response outlives the session.
    static func makeSession(cookieStorage: HTTPCookieStorage = cookieStorage()) -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = cookieStorage
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        return URLSession(configuration: configuration)
    }
}
