import XCTest
@testable import PWUsage

final class AppConfigurationTests: XCTestCase {
    func testDefaultsToProductionAPIOrigin() throws {
        let configuration = try AppConfiguration()

        XCTAssertEqual(configuration.apiOrigin.absoluteString, "https://pwusage.fm.rodeo")
    }

    func testAcceptsInjectedHTTPSOrigin() throws {
        let configuration = try AppConfiguration(apiOrigin: URL(string: "https://example.test")!)

        XCTAssertEqual(configuration.apiOrigin.absoluteString, "https://example.test")
    }

    func testReleaseRejectsNonHTTPSOrigin() {
        XCTAssertThrowsError(try AppConfiguration(apiOriginString: "http://localhost:3000"))
    }

    func testRejectsOriginWithPath() {
        XCTAssertThrowsError(try AppConfiguration(apiOriginString: "https://example.test/api"))
    }

    func testRejectsMalformedOrigin() {
        XCTAssertThrowsError(try AppConfiguration(apiOriginString: "not a url"))
    }

    func testDebugAllowsLocalHTTPOrigin() throws {
        let configuration = try AppConfiguration(apiOriginString: "http://localhost:3000", isRelease: false)

        XCTAssertEqual(configuration.apiOrigin.host, "localhost")
    }
}
