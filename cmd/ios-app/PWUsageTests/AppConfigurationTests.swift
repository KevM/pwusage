import Foundation
import Testing
@testable import PWUsage

@Suite("App Configuration Tests")
struct AppConfigurationTests {
    @Test("Defaults to production API origin")
    func defaultsToProductionAPIOrigin() throws {
        let configuration = try AppConfiguration()

        #expect(configuration.apiOrigin.absoluteString == "https://pwusage.fm.rodeo")
    }

    @Test("Accepts injected HTTPS origin")
    func acceptsInjectedHTTPSOrigin() throws {
        let configuration = try AppConfiguration(
            apiOrigin: try #require(URL(string: "https://example.test")),
            allowUnlistedHost: true
        )

        #expect(configuration.apiOrigin.absoluteString == "https://example.test")
    }

    @Test("Release rejects non-HTTPS origin")
    func releaseRejectsNonHTTPSOrigin() {
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOriginString: "http://localhost:3000")
        }
    }

    @Test("Rejects origin with path")
    func rejectsOriginWithPath() {
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOriginString: "https://pwusage.fm.rodeo/api")
        }
    }

    @Test("Rejects malformed origin")
    func rejectsMalformedOrigin() {
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOriginString: "not a url")
        }
    }

    @Test("Debug allows local HTTP origin")
    func debugAllowsLocalHTTPOrigin() throws {
        let configuration = try AppConfiguration(apiOriginString: "http://localhost:3000", isRelease: false)

        #expect(configuration.apiOrigin.host == "localhost")
    }

    @Test("Release rejects an unlisted host with no extra argument")
    func releaseRejectsUnlistedHostByDefault() {
        // The regression pin: a Release configuration is allowlisted by default,
        // so skipping the argument cannot quietly skip the check.
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOriginString: "https://example.test")
        }
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOrigin: URL(string: "https://evil.test")!)
        }
    }

    @Test("Release accepts the allowlisted host with no extra argument")
    func releaseAcceptsAllowlistedHostByDefault() throws {
        let fromString = try AppConfiguration(apiOriginString: "https://pwusage.fm.rodeo")
        let fromURL = try AppConfiguration(apiOrigin: try #require(URL(string: "https://pwusage.fm.rodeo")))

        #expect(fromString.apiOrigin.host == "pwusage.fm.rodeo")
        #expect(fromURL.apiOrigin.host == "pwusage.fm.rodeo")
    }

    @Test("Debug accepts an unlisted host with no extra argument")
    func debugAcceptsUnlistedHostByDefault() throws {
        let secure = try AppConfiguration(apiOriginString: "https://example.test", isRelease: false)
        let local = try AppConfiguration(apiOriginString: "http://localhost:5174", isRelease: false)

        #expect(secure.apiOrigin.host == "example.test")
        #expect(local.apiOrigin.absoluteString == "http://localhost:5174")
    }

    @Test("The host allowlist opt-out is explicit and still requires HTTPS")
    func hostAllowlistOptOutIsExplicit() throws {
        let configuration = try AppConfiguration(
            apiOriginString: "https://example.test",
            allowUnlistedHost: true
        )

        #expect(configuration.apiOrigin.host == "example.test")
        // Opting out of the allowlist is not opting out of Release entirely.
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration(apiOriginString: "http://example.test", allowUnlistedHost: true)
        }
    }

    @Test("Release accepts the production origin")
    func releaseAcceptsProductionAPIOrigin() throws {
        let configuration = try AppConfiguration.fromBundle(
            environment: ["PWUSAGE_API_ORIGIN": "https://pwusage.fm.rodeo"],
            isDebug: false
        )

        #expect(configuration.apiOrigin.absoluteString == "https://pwusage.fm.rodeo")
    }

    @Test("Release rejects the beta origin")
    func releaseRejectsBetaAPIOrigin() {
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration.fromBundle(
                environment: ["PWUSAGE_API_ORIGIN": "https://pwusagebeta.fm.rodeo"],
                isDebug: false
            )
        }
    }

    @Test("Debug allows a local HTTP origin from the environment")
    func debugAllowsLocalHTTPOriginFromEnvironment() throws {
        let configuration = try AppConfiguration.fromBundle(
            environment: ["PWUSAGE_API_ORIGIN": "http://localhost:5174"],
            isDebug: true
        )

        #expect(configuration.apiOrigin.absoluteString == "http://localhost:5174")
    }

    @Test("Debug falls back to beta, never production, when the origin is invalid")
    func debugFallsBackToBetaAPIOrigin() throws {
        let configuration = try AppConfiguration.fromBundle(
            environment: ["PWUSAGE_API_ORIGIN": "not a url"],
            isDebug: true
        )

        #expect(configuration.apiOrigin == AppConfiguration.debugFallbackAPIOrigin)
        #expect(configuration.apiOrigin.host == "pwusagebeta.fm.rodeo")
        #expect(configuration.initializationError != nil)
    }

    @Test("Release throws rather than defaulting when the origin is invalid")
    func releaseThrowsWhenOriginIsInvalid() {
        #expect(throws: AppConfiguration.ValidationError.invalidOrigin) {
            try AppConfiguration.fromBundle(
                environment: ["PWUSAGE_API_ORIGIN": "not a url"],
                isDebug: false
            )
        }
    }
}
