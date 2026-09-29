import Foundation
import Testing
@testable import PWUsage

/// Checks the decoder against a real Solcast capture when one is available.
///
/// Every other test in this suite runs on payloads written by the same author as
/// the decoder, so they cannot catch a wrong assumption about the provider's
/// schema or units. `cmd/next-app/scripts/solcast-forecast-capture.ts` writes a
/// redacted capture here; these assertions then run the app's own decoder over the
/// real bytes.
///
/// The suite is disabled when no capture is present, so a fresh clone still builds
/// and runs green. See the script header for how to produce one.
@Suite("Solcast Real Response Tests")
struct SolcastCaptureTests {
    /// Derived from the source file location so it does not depend on the test
    /// runner's working directory or on resource bundling.
    static var captureURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/solcast-capture.json")
    }

    static var hasCapture: Bool {
        FileManager.default.fileExists(atPath: captureURL.path)
    }

    private static func capture() throws -> [String: Any] {
        let data = try Data(contentsOf: captureURL)
        let root = try JSONSerialization.jsonObject(with: data)
        return try #require(root as? [String: Any])
    }

    /// Hands the real `forecast` object to the app's decoder untouched.
    private static func decodeForecast() throws -> SolcastForecastResponse {
        let root = try capture()
        let forecast = try #require(root["forecast"] as? [String: Any])
        let bytes = try JSONSerialization.data(withJSONObject: forecast)
        return try SolcastClientForecastDecoder.decode(bytes)
    }

    @Test("A real capture decodes and yields plausible residential kilowatts", .enabled(if: hasCapture))
    func realCaptureDecodesToPlausibleKilowatts() throws {
        let response = try Self.decodeForecast()
        #expect(!response.forecasts.isEmpty)

        // A home array is single-digit kilowatts. A milliwatt-scale value means the
        // provider reports MW and we failed to convert, which is the bug this test
        // exists to catch.
        let peak = try #require(response.forecasts.compactMap(\.pvEstimateKw).max())
        #expect(peak > 0.5, "Decoded peak was \(peak) kW, which looks like unconverted MW")
        #expect(peak < 50, "Decoded peak was \(peak) kW, far above any residential array")

        for point in response.forecasts {
            #expect(point.periodDuration > 0)
            #expect(point.pvEstimateKw ?? 0 >= 0)
        }
    }

    @Test("A real capture carries future periods, not history", .enabled(if: hasCapture))
    func realCaptureCoversTheFuture() throws {
        let response = try Self.decodeForecast()
        let now = Date.now

        // The estimator searches from now to end of tomorrow. If the provider only
        // returned history, every comparison would be unavailable and the reason
        // would not be obvious.
        let latest = try #require(response.forecasts.map(\.periodEnd).max())
        #expect(latest > now, "Latest period \(latest) is not in the future")
    }

    @Test("A real discovery capture yields path-safe redacted resource IDs", .enabled(if: hasCapture))
    func realDiscoveryCaptureIsPathSafe() throws {
        let root = try Self.capture()
        let discovery = try #require(root["discovery"] as? [String: Any])
        let sites = try #require(discovery["sites"] as? [[String: Any]])
        #expect(!sites.isEmpty)
        for site in sites {
            let id = try #require(site["resource_id"] as? String)
            #expect(!id.isEmpty)
            #expect(!id.contains(".."))
            #expect(!id.contains("/"))
        }
    }
}

/// Mirrors what `SolcastClient` does with a response body, so the capture is
/// exercised through the same decode path the app uses.
private enum SolcastClientForecastDecoder {
    static func decode(_ data: Data) throws -> SolcastForecastResponse {
        try JSONDecoder().decode(SolcastForecastResponse.self, from: data)
    }
}
