import Foundation

struct AppConfiguration: Equatable {
    static let defaultAPIOrigin = URL(string: "https://pwusage.fm.rodeo")!

    let apiOrigin: URL

    init(apiOrigin: URL = Self.defaultAPIOrigin, isRelease: Bool = true) throws {
        try Self.validate(apiOrigin, isRelease: isRelease)
        self.apiOrigin = apiOrigin
    }

    init(apiOriginString: String, isRelease: Bool = true) throws {
        guard let url = URL(string: apiOriginString) else {
            throw ValidationError.invalidOrigin
        }
        try self.init(apiOrigin: url, isRelease: isRelease)
    }

    static func fromBundle(_ bundle: Bundle = .main) throws -> AppConfiguration {
        let configuredOrigin = ProcessInfo.processInfo.environment["PWUSAGE_API_ORIGIN"]
            ?? bundle.object(forInfoDictionaryKey: "PWUSAGE_API_ORIGIN") as? String
            ?? defaultAPIOrigin.absoluteString
        #if DEBUG
        return try AppConfiguration(apiOriginString: configuredOrigin, isRelease: false)
        #else
        return try AppConfiguration(apiOriginString: configuredOrigin, isRelease: true)
        #endif
    }

    enum ValidationError: Error, Equatable {
        case invalidOrigin
    }

    private static func validate(_ url: URL, isRelease: Bool) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil,
              components.fragment == nil,
              (scheme == "https" || (!isRelease && scheme == "http")) else {
            throw ValidationError.invalidOrigin
        }
    }
}
