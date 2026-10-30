import Foundation
@testable import PWUsage
import Testing

@Suite("Solar layout sun and plane-of-array parity")
struct SolarLayoutSunPOATests {
    static let fixtureNames = ["east-west-30d", "east-west-year", "south-clipped-year", "south-shaded-100d"]

    @Test func fixturesAreBundled() throws {
        for name in Self.fixtureNames {
            let fixture = try SolarLayoutFixture.load(name)
            #expect(fixture.name == name)
            #expect(fixture.stages.sun.count == 48)
            #expect(fixture.stages.poa.kw.count == fixture.stages.sun.count)
            #expect(!fixture.input.solarWh.isEmpty)
        }
    }

    @Test(arguments: fixtureNames)
    func sunMatchesFixture(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        for row in fixture.stages.sun {
            let sun = layoutSun(at: row.timestamp, latitude: fixture.input.latitude, longitude: fixture.input.longitude)
            let label = "\(name) \(row.timestamp.ISO8601Format())"
            expectClose(sun.apparentZenith, row.apparentZenith, "\(label) apparentZenith")
            expectClose(sun.elevation, row.elevation, "\(label) elevation")
            expectClose(sun.azimuth, row.azimuth, "\(label) azimuth")
            expectClose(sun.dniExtra, row.dniExtra, "\(label) dniExtra")
            expectClose(sun.ghi, row.ghi, "\(label) ghi")
            expectClose(sun.dni, row.dni, "\(label) dni")
            expectClose(sun.dhi, row.dhi, "\(label) dhi")
            expectClose(sun.ambientFactor, row.ambientFactor, "\(label) ambientFactor")
        }
    }

    @Test(arguments: fixtureNames)
    func poaMatchesFixture(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let planes = fixture.stages.poa.planes.map {
            LayoutPlane(azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.effectiveKw)
        }
        for (row, expected) in zip(fixture.stages.sun, fixture.stages.poa.kw) {
            let sun = LayoutSunSample(
                apparentZenith: row.apparentZenith, elevation: row.elevation, azimuth: row.azimuth,
                dniExtra: row.dniExtra, ghi: row.ghi, dni: row.dni, dhi: row.dhi, ambientFactor: row.ambientFactor)
            let label = "\(name) \(row.timestamp.ISO8601Format()) kw"
            expectClose(LayoutPOA.modelKw(sun: sun, planes: planes), expected, label)
        }
    }

    /// Relative 1e-9, or absolute 1e-9 when the expected value is below 1.
    private func expectClose(_ actual: Double, _ expected: Double, _ label: String) {
        let tolerance = 1e-9 * max(1, abs(expected))
        #expect(abs(actual - expected) <= tolerance, "\(label): \(actual) vs \(expected)")
    }
}
