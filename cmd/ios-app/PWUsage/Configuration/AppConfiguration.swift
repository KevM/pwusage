import Foundation
import OSLog

struct AppConfiguration: Equatable {
    static let defaultAPIOrigin = URL(string: "https://pwusage.fm.rodeo")!

    /// Where a Debug build points when the configured origin is unusable. Never
    /// production: a Debug build that quietly talks to production is the failure
    /// this exists to prevent, and beta is the host a Debug build is meant to
    /// talk to anyway.
    static let debugFallbackAPIOrigin = URL(string: "https://pwusagebeta.fm.rodeo")!

    /// The only hosts a Release configuration may name. Release rules apply to
    /// every configuration the app ships, so this is enforced by default rather
    /// than by a call site that has to remember. Debug is deliberately
    /// unconstrained so local development against `http://localhost` keeps
    /// working. The `site_auth` session cookie is scoped to the origin the app
    /// talks to, so a wrong host fails quietly rather than loudly.
    static let releasedAPIOriginHosts: Set<String> = ["pwusage.fm.rodeo"]

    /// The only port a Release origin may name, and only because it is the
    /// default for `https`. A nonstandard port is a different origin, so it needs
    /// its own explicit sign-off rather than riding in on the host allowlist.
    static let releasedAPIOriginPort = 443

    private static let logger = Logger(subsystem: "fm.rodeo.pwusage", category: "configuration")

    let apiOrigin: URL

    /// Non-nil when the configured origin was unusable and `apiOrigin` is a
    /// fallback rather than what the build asked for.
    let initializationError: String?

    /// - Parameters:
    ///   - isRelease: whether Release rules apply, i.e. whether HTTPS is required
    ///     and the host must be an allowlist entry.
    ///   - allowUnlistedHost: opts out of the Release host allowlist. It defaults
    ///     to `false` so the safe state is the absence of an argument, and a
    ///     caller that skips the check has to say so in its own source. Only
    ///     tests and previews, which name hosts that do not exist, should set it.
    init(
        apiOrigin: URL = Self.defaultAPIOrigin,
        isRelease: Bool = true,
        allowUnlistedHost: Bool = false
    ) throws {
        try Self.validate(apiOrigin, isRelease: isRelease, allowUnlistedHost: allowUnlistedHost)
        self.apiOrigin = apiOrigin
        self.initializationError = nil
    }

    init(apiOriginString: String, isRelease: Bool = true, allowUnlistedHost: Bool = false) throws {
        guard let url = URL(string: apiOriginString) else {
            throw ValidationError.invalidOrigin
        }
        try self.init(apiOrigin: url, isRelease: isRelease, allowUnlistedHost: allowUnlistedHost)
    }

    private init(fallbackOrigin: URL, reason: String) {
        self.apiOrigin = fallbackOrigin
        self.initializationError = reason
    }

    /// Resolves the API origin from the build configuration.
    ///
    /// An unusable origin is a build misconfiguration, not a runtime condition,
    /// so it is logged in both configurations rather than swallowed. Debug falls
    /// back to the beta host, so a typo in a scheme environment variable cannot
    /// turn a Debug build into a production client. Release has no safe
    /// substitute, so it refuses and leaves the caller to report the failure.
    static func fromBundle(
        _ bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isDebug: Bool = Self.buildIsDebug
    ) throws -> AppConfiguration {
        let configuredOrigin = environment["PWUSAGE_API_ORIGIN"]
            ?? bundle.object(forInfoDictionaryKey: "PWUSAGE_API_ORIGIN") as? String
            ?? defaultAPIOrigin.absoluteString
        do {
            // No opt-out: this is the path a shipped origin travels.
            return try AppConfiguration(apiOriginString: configuredOrigin, isRelease: !isDebug)
        } catch {
            let reason = "PWUSAGE_API_ORIGIN \"\(configuredOrigin)\" is not a valid API origin."
            logger.error("\(reason, privacy: .public)")
            guard isDebug else { throw error }
            return AppConfiguration(fallbackOrigin: debugFallbackAPIOrigin, reason: reason)
        }
    }

    private static var buildIsDebug: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    enum ValidationError: Error, Equatable {
        case invalidOrigin
    }

    private static func validate(_ url: URL, isRelease: Bool, allowUnlistedHost: Bool) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil,
              components.fragment == nil,
              (scheme == "https" || (!isRelease && scheme == "http")) else {
            throw ValidationError.invalidOrigin
        }
        // Required HTTPS is not the same as required *ours*: a Release
        // configuration that names another host ships a client pointed at a
        // server nobody chose, and its session cookie is scoped to that host.
        guard allowUnlistedHost || !isRelease || releasedAPIOriginHosts.contains(host) else {
            throw ValidationError.invalidOrigin
        }
        // The allowlist names a host, but the origin the client dials is host *and*
        // port, so a host check alone leaves `:8443` — or any other nonstandard
        // port — routing the shipped client somewhere nobody chose. Only the
        // scheme's default port is the same origin; `443` spelled out is accepted
        // because it resolves identically. Debug is unconstrained for the same
        // reason it is unconstrained on host: local development needs its port.
        guard !isRelease || components.port == nil || components.port == Self.releasedAPIOriginPort else {
            throw ValidationError.invalidOrigin
        }
    }
}
