import Foundation
@testable import PWUsage
import Testing

@Suite("Open-Meteo on-device solar array model")
struct OpenMeteoArrayModelTests {
    struct Case: Sendable {
        let name: String
        let unix: TimeInterval
        let latitude: Double
        let longitude: Double
        let ghi: Double
        let dni: Double
        let dhi: Double
        let azimuth: Double
        let tilt: Double
        let capacityKw: Double
        let clip: Double?
        let expected: Double
    }

    static let cases: [Case] = [
        // Generated with pvlib 0.16.1; synthetic irradiance, no household data.
        Case(name: "north_summer_south", unix: 1718991000,
             latitude: 43, longitude: -88,
             ghi: 850, dni: 800, dhi: 150,
             azimuth: 180, tilt: 25, capacityKw: 6, clip: nil,
             expected: 4.926635505766),
        Case(name: "north_winter_south", unix: 1734802200,
             latitude: 43, longitude: -88,
             ghi: 320, dni: 650, dhi: 70,
             azimuth: 180, tilt: 40, capacityKw: 6, clip: nil,
             expected: 3.581118338274),
        Case(name: "east_morning", unix: 1718973000,
             latitude: 43, longitude: -88,
             ghi: 250, dni: 450, dhi: 100,
             azimuth: 90, tilt: 25, capacityKw: 6, clip: nil,
             expected: 2.342249709581),
        Case(name: "west_evening", unix: 1719012600,
             latitude: 43, longitude: -88,
             ghi: 200, dni: 400, dhi: 90,
             azimuth: 270, tilt: 25, capacityKw: 6, clip: nil,
             expected: 2.023275966659),
        Case(name: "southern_summer", unix: 1734744600,
             latitude: -34, longitude: 151,
             ghi: 900, dni: 850, dhi: 160,
             azimuth: 0, tilt: 30, capacityKw: 6, clip: nil,
             expected: 4.972249189073),
        Case(name: "southern_winter", unix: 1718933400,
             latitude: -34, longitude: 151,
             ghi: 400, dni: 700, dhi: 90,
             azimuth: 0, tilt: 30, capacityKw: 6, clip: nil,
             expected: 3.821698304970),
        Case(name: "equator_equinox", unix: 1710934200,
             latitude: 0, longitude: 0,
             ghi: 950, dni: 850, dhi: 100,
             azimuth: 180, tilt: 5, capacityKw: 6, clip: nil,
             expected: 4.826946032409),
        Case(name: "clipping", unix: 1718991000,
             latitude: 43, longitude: -88,
             ghi: 1000, dni: 900, dhi: 200,
             azimuth: 180, tilt: 25, capacityKw: 10, clip: 3,
             expected: 3.000000000000),
        Case(name: "overcast", unix: 1729531800,
             latitude: 43, longitude: -88,
             ghi: 180, dni: 0, dhi: 180,
             azimuth: 180, tilt: 25, capacityKw: 6, clip: nil,
             expected: 0.896167002225),
        Case(name: "low_sun", unix: 1734791400,
             latitude: 43, longitude: -88,
             ghi: 70, dni: 300, dhi: 40,
             azimuth: 90, tilt: 30, capacityKw: 6, clip: nil,
             expected: 1.008305745262),
        Case(name: "night", unix: 1718947800,
             latitude: 43, longitude: -88,
             ghi: 0, dni: 0, dhi: 0,
             azimuth: 180, tilt: 25, capacityKw: 6, clip: nil,
             expected: 0.000000000000)]

    @Test("Matches independent pvlib synthetic cases", arguments: cases)
    func pvlibParity(_ sample: Case) throws {
        let result = try OpenMeteoArrayModel.powerKw(
            at: Date(timeIntervalSince1970: sample.unix), ghi: sample.ghi, dni: sample.dni, dhi: sample.dhi,
            layout: SolarLayout(
                planes: [.init(azimuth: sample.azimuth, tilt: sample.tilt, dcKwp: sample.capacityKw)],
                acClipKw: sample.clip, confidence: .high, detectedAt: nil),
            location: .init(latitude: sample.latitude, longitude: sample.longitude, source: .estimated)
        )
        // NOAA/Meeus geometry approximates SPA: 1% relative or 3 W absolute tolerance.
        #expect(abs(result - sample.expected) <= max(0.003, sample.expected * 0.01), "\(sample.name)")
    }

    @Test("Rejects non-finite or negative weather and invalid geometry")
    func rejectsInvalidInputs() throws {
        let layout = SolarLayout(
            planes: [.init(azimuth: 180, tilt: 25, dcKwp: 6)],
            acClipKw: nil, confidence: .high, detectedAt: nil)
        let location = SolarHomeLocation(latitude: 43, longitude: -88, source: .estimated)
        for irradiance in [-1.0, Double.nan, Double.infinity] {
            #expect(throws: OpenMeteoArrayModel.Error.invalidInput) {
                try OpenMeteoArrayModel.powerKw(
                    at: Date(timeIntervalSince1970: 0), ghi: irradiance, dni: 0, dhi: 0,
                    layout: layout, location: location)
            }
        }
        #expect(throws: OpenMeteoArrayModel.Error.invalidInput) {
            try OpenMeteoArrayModel.powerKw(
                at: Date(timeIntervalSince1970: 0), ghi: 0, dni: 0, dhi: 0,
                layout: layout,
                location: .init(latitude: .nan, longitude: 0, source: .estimated))
        }
    }

    @Test("Plane output adds before the shared inverter clip")
    func addsPlanesBeforeClipping() throws {
        let location = SolarHomeLocation(latitude: 43, longitude: -88, source: .estimated)
        let plane = SolarLayoutPlane(azimuth: 180, tilt: 25, dcKwp: 6)
        let date = Date(timeIntervalSince1970: 1_718_991_000)
        func output(_ planes: [SolarLayoutPlane], clip: Double?) throws -> Double {
            try OpenMeteoArrayModel.powerKw(
                at: date, ghi: 850, dni: 800, dhi: 150,
                layout: .init(planes: planes, acClipKw: clip, confidence: .high, detectedAt: nil),
                location: location)
        }
        let single = try output([plane], clip: nil)
        #expect(abs(try output([plane, plane], clip: nil) - 2 * single) < 1e-10)
        #expect(try output([plane, plane], clip: 3) == min(3, 2 * single))
    }
}
