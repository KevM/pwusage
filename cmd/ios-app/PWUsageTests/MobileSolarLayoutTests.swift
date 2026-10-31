import Foundation
@testable import PWUsage
import Testing

@Suite("Mobile solar layout contract")
struct MobileSolarLayoutTests {
    private func layout(_ json: String) throws -> MobileSolarLayoutResponse {
        try MobileContractDecoder.make().decode(MobileSolarLayoutResponse.self, from: Data(json.utf8))
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

    private static func enabledJSON(
        location: String = "null", layout: String = "null", reason: String = "null"
    ) -> String {
        #"{"version":1,"enabled":true,"location":\#(location),"layout":\#(layout),"reason":\#(reason)}"#
    }

    private static func layoutJSON(planes: String, clip: String = "null", confidence: String = "high") -> String {
        enabledJSON(
            layout: #"{"planes":[\#(planes)],"acClipKw":\#(clip),"confidence":"\#(confidence)","detectedAt":null}"#
        )
    }

    private static let plane: String = #"{"azimuth":90,"tilt":18,"dcKwp":1}"#

    private static let invalidLayouts: [String] = [
        #"{"version":2,"enabled":false}"#,
        enabledJSON(location: #"{"latitude":91,"longitude":0}"#),
        enabledJSON(location: #"{"latitude":0,"longitude":-181}"#),
        enabledJSON(location: #"{"latitude":0,"longitude":0,"source":"guess"}"#),
        layoutJSON(planes: ""),
        layoutJSON(planes: Array(repeating: plane, count: 4).joined(separator: ",")),
        layoutJSON(planes: #"{"azimuth":400,"tilt":18,"dcKwp":1}"#),
        layoutJSON(planes: #"{"azimuth":90,"tilt":95,"dcKwp":1}"#),
        layoutJSON(planes: #"{"azimuth":90,"tilt":18,"dcKwp":0}"#),
        layoutJSON(planes: plane, clip: "0"),
        layoutJSON(planes: plane, confidence: "low"),
        enabledJSON(reason: #""location-mismatch""#)]

    @Test("Unsupported versions and invalid values are rejected", arguments: invalidLayouts)
    func rejected(json: String) {
        #expect(throws: (any Error).self) { try layout(json) }
    }
}
