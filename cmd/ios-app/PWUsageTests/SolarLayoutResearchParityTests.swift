import Foundation
@testable import PWUsage
import Testing

/// Local-only parity run for the detector against the Python reference's research sites.
/// Research data never enters the repo: point PWUSAGE_SOLAR_PARITY_DIR at a folder outside it,
/// passed through xcodebuild as TEST_RUNNER_PWUSAGE_SOLAR_PARITY_DIR=/abs/path ./run-tests.sh ….
/// The folder holds site-*.csv (timestamp,solar_wh; UTC interval start, Wh per 5 minutes) and
/// inputs.json, the same format as scripts/solar-layout-parity.ts. Each site writes
/// <site>.swift.json beside its CSV. Without the variable the test is disabled.
@Suite("Solar layout research parity")
struct SolarLayoutResearchParityTests {
    static let environmentKey = "PWUSAGE_SOLAR_PARITY_DIR"

    @Test(.enabled(if: ProcessInfo.processInfo.environment[environmentKey] != nil))
    func writesDetectionPerResearchSite() throws {
        let path = try #require(ProcessInfo.processInfo.environment[Self.environmentKey])
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let inputs = try JSONDecoder().decode(
            Inputs.self, from: Data(contentsOf: directory.appending(path: "inputs.json")))
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasPrefix("site-") && $0.hasSuffix(".csv") }
            .sorted()

        for file in files {
            let site = String(file.dropLast(".csv".count))
            guard let config = inputs.sites[site] else { continue }
            let timeZone = try #require(TimeZone(identifier: config.timezone))
            let samples = try Self.samples(csv: directory.appending(path: file))

            let started = ProcessInfo.processInfo.systemUptime
            let result = try SolarLayoutDetector.detect(
                samples: samples, latitude: config.lat, longitude: config.lon, timeZone: timeZone,
                checkCancellation: {})
            let runtimeMs = Int(((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded())

            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any] ?? [:]
            object["runtimeMs"] = runtimeMs
            let output = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            try output.write(to: directory.appending(path: "\(site).swift.json"))
        }
    }

    private struct Inputs: Decodable {
        let sites: [String: ResearchSite]
    }

    private struct ResearchSite: Decodable {
        let timezone: String
        let lat: Double
        let lon: Double
    }

    private static func samples(csv url: URL) throws -> [(timestamp: Date, solarWh: Double)] {
        let text = try String(contentsOf: url, encoding: .utf8)
        let formatter = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try text.split(whereSeparator: \.isNewline).dropFirst().map { line in
            let fields = line.split(separator: ",", omittingEmptySubsequences: false)
            guard fields.count >= 2 else { throw CocoaError(.fileReadCorruptFile) }
            let timestamp = String(fields[0])
            guard let date = formatter.date(from: timestamp) ?? fractional.date(from: timestamp),
                  let energyWh = Double(fields[1]) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return (timestamp: date, solarWh: energyWh)
        }
    }
}
