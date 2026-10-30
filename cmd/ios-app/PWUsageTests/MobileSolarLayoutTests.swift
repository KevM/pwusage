import Foundation
@testable import PWUsage
import Testing

@Suite("Mobile solar layout contract")
struct MobileSolarLayoutTests {
    private func layout(_ json: String) throws -> MobileSolarLayoutResponse {
        try MobileContractDecoder.make().decode(MobileSolarLayoutResponse.self, from: Data(json.utf8))
    }

    private func actuals(_ json: String) throws -> MobileSolarActualsResponse {
        try MobileContractDecoder.make().decode(MobileSolarActualsResponse.self, from: Data(json.utf8))
    }

    private static let twoPlanes = """
    "layout":{"planes":[{"azimuth":90,"tilt":18,"dcKwp":5.6},{"azimuth":270,"tilt":18,"dcKwp":4.0}],
    "acClipKw":null,"confidence":"high","detectedAt":"2026-10-20T10:00:00Z"}
    """

    @Test("A disabled layout response decodes to disabled")
    func disabled() throws {
        #expect(try layout(#"{"version":1,"enabled":false}"#) == .disabled)
    }

    @Test("A detected two-plane layout decodes its planes, confidence and estimated location")
    func detected() throws {
        let response = try layout("""
        {"version":1,"enabled":true,"location":{"latitude":43.39,"longitude":-87.87,"source":"estimated"},
        \(Self.twoPlanes),"reason":null}
        """)
        guard case .enabled(let location, let layout, let reason) = response else {
            Issue.record("Expected enabled")
            return
        }
        #expect(location == SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .estimated))
        let expectedPlanes = [
            SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6),
            SolarLayoutPlane(azimuth: 270, tilt: 18, dcKwp: 4.0)]
        #expect(layout?.planes == expectedPlanes)
        #expect(layout?.confidence == .high)
        #expect(layout?.acClipKw == nil)
        #expect(reason == nil)
    }

    @Test("A location without a source is treated as coming from the phone")
    func missingSourceIsDevice() throws {
        let response = try layout("""
        {"version":1,"enabled":true,"location":{"latitude":43.39,"longitude":-87.87},"layout":null,"reason":"pending"}
        """)
        #expect(response == .enabled(
            location: SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device),
            layout: nil, reason: .pending))
    }

    @Test("Low confidence with no layout and a null detection time both decode")
    func lowConfidenceAndNullDetectedAt() throws {
        #expect(try layout("""
        {"version":1,"enabled":true,"location":null,"layout":null,"reason":"low-confidence"}
        """) == .enabled(location: nil, layout: nil, reason: .lowConfidence))
        let response = try layout("""
        {"version":1,"enabled":true,"location":null,"layout":{"planes":[{"azimuth":205,"tilt":20,"dcKwp":5.2}],
        "acClipKw":4.5,"confidence":"medium","detectedAt":null},"reason":null}
        """)
        guard case .enabled(_, let detected?, _) = response else {
            Issue.record("Expected a layout")
            return
        }
        #expect(detected.detectedAt == nil)
        #expect(detected.acClipKw == 4.5)
        #expect(detected.confidence == .medium)
    }

    private static let reasonCases: [(String, MobileSolarLayoutReason)] = [
        ("needs-location", .needsLocation),
        ("pending", .pending),
        ("not-enough-history", .notEnoughHistory),
        ("low-confidence", .lowConfidence)]

    @Test("Every reason decodes", arguments: reasonCases)
    func reasons(raw: String, reason: MobileSolarLayoutReason) throws {
        #expect(try layout(#"{"version":1,"enabled":true,"location":null,"layout":null,"reason":"\#(raw)"}"#)
            == .enabled(location: nil, layout: nil, reason: reason))
    }

    private static func enabled(location: String = "null", layout: String = "null", reason: String = "null") -> String {
        #"{"version":1,"enabled":true,"location":\#(location),"layout":\#(layout),"reason":\#(reason)}"#
    }

    private static func layout(planes: String, clip: String = "null", confidence: String = "high") -> String {
        enabled(layout: #"{"planes":[\#(planes)],"acClipKw":\#(clip),"confidence":"\#(confidence)","detectedAt":null}"#)
    }

    private static let plane = #"{"azimuth":90,"tilt":18,"dcKwp":1}"#

    private static let invalidLayouts = [
        #"{"version":2,"enabled":false}"#,
        enabled(location: #"{"latitude":91,"longitude":0}"#),
        enabled(location: #"{"latitude":0,"longitude":-181}"#),
        enabled(location: #"{"latitude":0,"longitude":0,"source":"guess"}"#),
        layout(planes: ""),
        layout(planes: Array(repeating: plane, count: 4).joined(separator: ",")),
        layout(planes: #"{"azimuth":400,"tilt":18,"dcKwp":1}"#),
        layout(planes: #"{"azimuth":90,"tilt":95,"dcKwp":1}"#),
        layout(planes: #"{"azimuth":90,"tilt":18,"dcKwp":0}"#),
        layout(planes: plane, clip: "0"),
        layout(planes: plane, confidence: "low"),
        enabled(reason: #""location-mismatch""#)]

    @Test("Unsupported versions and invalid values are rejected", arguments: invalidLayouts)
    func rejected(json: String) {
        #expect(throws: (any Error).self) { try layout(json) }
    }

    @Test("Actuals decode when disabled and when enabled with incomplete hours")
    func actualsDecode() throws {
        #expect(try actuals(#"{"version":1,"enabled":false}"#) == .disabled)
        let response = try actuals("""
        {"version":1,"enabled":true,"asOf":"2026-10-28T15:05:00Z","hours":[
        {"hourStart":"2026-10-28T14:00:00Z","wh":1234.5,"complete":true},
        {"hourStart":"2026-10-28T15:00:00Z","wh":80,"complete":false}]}
        """)
        let asOf = try #require(ISO8601DateFormatter().date(from: "2026-10-28T15:05:00Z"))
        let first = try #require(ISO8601DateFormatter().date(from: "2026-10-28T14:00:00Z"))
        let hours = [
            MobileSolarActualsHour(hourStart: first, energyWh: 1234.5, complete: true),
            MobileSolarActualsHour(hourStart: first.addingTimeInterval(3600), energyWh: 80, complete: false)]
        #expect(response == .enabled(asOf: asOf, hours: hours))
    }

    private static let invalidActuals = [
        #"{"version":2,"enabled":false}"#,
        #"{"version":2,"enabled":true,"asOf":"2026-10-28T15:05:00Z","hours":[]}"#,
        #"{"version":1,"enabled":true,"asOf":"2026-10-28T15:05:00Z","hours":["#
            + #"{"hourStart":"2026-10-28T14:00:00Z","wh":-1,"complete":true}]}"#,
        #"{"version":1,"enabled":true,"hours":[]}"#]

    @Test("Actuals reject unsupported versions and invalid energy", arguments: invalidActuals)
    func actualsRejected(json: String) {
        #expect(throws: (any Error).self) { try actuals(json) }
    }
}
