import Foundation
@testable import PWUsage
import Testing

@Suite("Solar health reference and fit")
struct SolarHealthReferenceTests {
    private static func reference(_ planes: [SolarHealthPlane]) throws -> SolarHealthReference {
        try #require(SolarHealthReference(manual: manualLayout(for: planes), detected: nil))
    }

    @Test func manualFacesAreOnePlaneEachAtNameplateTimesDerate() throws {
        let layout = ManualSolarLayout(systems: [ManualSolarSystem(faces: [
            ManualSolarFace(panelCount: 10, panelWatts: 400, azimuthDegrees: 100, tiltDegrees: 20),
            ManualSolarFace(panelCount: 8, panelWatts: 400, azimuthDegrees: 280, tiltDegrees: 20)
        ])])
        let reference = try #require(SolarHealthReference(manual: layout, detected: nil))
        #expect(reference.source == .manual)
        let planes = reference.planes(on: .now)
        #expect(planes.count == 2)
        #expect(abs(planes[0].effectiveKw - 4 * SolarLayoutDetector.derate) < 1e-9)
        #expect(abs(planes[1].effectiveKw - 3.2 * SolarLayoutDetector.derate) < 1e-9)
    }

    @Test func onlySystemsInstalledByADateCount() throws {
        let early = Date(timeIntervalSince1970: 1_500_000_000)
        let late = Date(timeIntervalSince1970: 1_700_000_000)
        let layout = manualLayout(for: SolarHealthPlaneSet.eastWest, installDates: [early, late])
        let reference = try #require(SolarHealthReference(manual: layout, detected: nil))
        #expect(reference.planes(on: early.addingTimeInterval(-86_400)).isEmpty)
        #expect(reference.planes(on: early.addingTimeInterval(86_400)).count == 1)
        #expect(reference.planes(on: late.addingTimeInterval(86_400)).count == 2)
    }

    @Test func detectedGeometryIsTheReferenceWithoutAManualLayout() {
        let detected = DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [],
            planes: [.init(azimuth: 170, tilt: 22, dcKwp: 6, effectiveKw: 5.1, azimuthRange90: [160, 180], tiltRange90: [20, 24])],
            acClipKw: nil, historyDays: 300, clearDays: 60, firstDay: nil, lastDay: nil)
        let reference = SolarHealthReference(manual: nil, detected: detected)
        #expect(reference?.source == .detected)
        #expect(reference?.planes(on: .now) == [SolarHealthPlane(azimuth: 170, tilt: 22, effectiveKw: 5.1)])
        #expect(SolarHealthReference(manual: nil, detected: nil) == nil)
    }

    @Test func eastAndWestAreSeparateDirectionsAndSouthFacesShare() throws {
        #expect(try Self.reference([.face(90), .face(270)]).directions.map(\.azimuth) == [90, 270])
        #expect(try Self.reference([.face(180, tilt: 20), .face(185, tilt: 35)]).directions.count == 1)
        #expect(try Self.reference([.face(350), .face(10)]).directions.count == 1)
        #expect(try Self.reference([.face(100), .face(190), .face(280)]).directions.count == 3)
    }

    @Test func theKeyChangesWithAnyFaceOrInstallDate() throws {
        let base = try Self.reference([.face(90), .face(270)])
        #expect(base.key == (try Self.reference([.face(90), .face(270)])).key)
        #expect(base.key != (try Self.reference([.face(90), .face(270, kw: 3.5)])).key)
        #expect(base.key != (try Self.reference([.face(90), .face(271)])).key)
        let dated = manualLayout(
            for: SolarHealthPlaneSet.eastWest, installDates: [nil, Date(timeIntervalSince1970: 1_700_000_000)])
        #expect(base.key != (try #require(SolarHealthReference(manual: dated, detected: nil))).key)
    }

    @Test func seasonsFollowTheHemisphere() {
        #expect(SolarSeason.of(month: 12, latitude: 43) == .winter)
        #expect(SolarSeason.of(month: 7, latitude: 43) == .summer)
        #expect(SolarSeason.of(month: 12, latitude: -33) == .summer)
        #expect(SolarSeason.of(month: 4, latitude: -33) == .autumn)
    }

    @Test func fitRecoversFactorsAndSharesInseparableDirections() {
        let east = (0 ..< 400).map { 1 + 0.5 * sin(Double($0) / 20) }
        let west = (0 ..< 400).map { 1 + 0.5 * cos(Double($0) / 20) }
        let measured = (0 ..< 400).map { 1.0 * east[$0] + 0.8 * west[$0] }
        let separated = SolarHealthFit.scales(measured: measured, models: [east, west], rows: Array(0 ..< 400))
        #expect(abs((separated?.perDirection?[0] ?? 0) - 1) < 1e-9)
        #expect(abs((separated?.perDirection?[1] ?? 0) - 0.8) < 1e-9)
        // A west column that is a multiple of the east one cannot be separated.
        let scaled = east.map { $0 * 0.9 }
        let shared = SolarHealthFit.scales(measured: east, models: [east, scaled], rows: Array(0 ..< 400))
        #expect(shared?.perDirection == nil)
        #expect(abs((shared?.site ?? 0) - 1 / 1.9) < 1e-9)
        #expect(SolarHealthFit.scales(measured: measured, models: [east, west], rows: Array(0 ..< 10)) == nil)
    }
}

enum SolarHealthPlaneSet {
    static let eastWest = [SolarHealthPlane.face(90), .face(270)]
}
