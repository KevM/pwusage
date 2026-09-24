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
        let configuration = try AppConfiguration(apiOrigin: try #require(URL(string: "https://example.test")))

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
            try AppConfiguration(apiOriginString: "https://example.test/api")
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
}
