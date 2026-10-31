import Foundation
@testable import PWUsage
import Testing

@Suite("Solar layout fit parity")
struct SolarLayoutFitTests {
    static let fixtureNames = ["east-west-30d", "east-west-year", "south-clipped-year", "south-shaded-100d"]

    /// Reference planes from the TypeScript `fitFromGram` (one and two planes) on the fixture's
    /// 48 daylight rows, flattened as [azimuth, tilt, effectiveKw, ...]; two-plane sorted by azimuth.
    static let fitReferences: [FitReference] = [
        FitReference(
            name: "east-west-30d",
            onePlane: [16.638800913734826, 6.396857729276779, 8.835797812914267],
            twoPlanes: [
                90.00000011117316, 19.999999984357554, 5.000000003702334,
                270.0000001461078, 20.00000001772456, 3.9999999963247994,
            ]),
        FitReference(
            name: "east-west-year",
            onePlane: [85.42112023432622, 1.843988257705627, 8.509121643557934],
            twoPlanes: [
                90.0000000000291, 19.999999998097614, 5.000000000249034,
                269.99999999994884, 19.999999999932687, 3.9999999996844773,
            ]),
        FitReference(
            name: "south-clipped-year",
            onePlane: [85.42112023432622, 1.843988257705627, 8.509121643557934],
            twoPlanes: [
                90.0000000000291, 19.999999998097614, 5.000000000249034,
                269.99999999994884, 19.999999999932687, 3.9999999996844773,
            ]),
        FitReference(
            name: "south-shaded-100d",
            onePlane: [34.351771707686794, 3.6326473899237848, 8.639022005816944],
            twoPlanes: [
                90.00000002024461, 19.999999992597623, 5.000000001542716,
                270.00000003730224, 20.000000007357507, 3.999999998555364,
            ]),
    ]

    struct FitReference: Sendable {
        let name: String
        let onePlane: [Double]
        let twoPlanes: [Double]
    }

    struct Cancelled: Error {}

    /// The first ten `seededRng(7)` draws from the TypeScript implementation, exact.
    @Test func seededRngMatchesTypeScript() {
        let expected: [Double] = [
            0.011704753153026104, 0.06195825757458806, 0.97690763277933,
            0.6990287057124078, 0.5214452685322613, 0.4055216880515218,
            0.4662326325196773, 0.23992518591694534, 0.5533256039489061,
            0.729822089895606,
        ]
        let rng = LayoutFit.seededRng(7)
        for (index, value) in expected.enumerated() {
            #expect(rng() == value, "draw \(index)")
        }
    }

    @Test(arguments: fitReferences)
    func fitMatchesTypeScriptOnFixtureRows(reference: FitReference) throws {
        let rows = try Self.rows(for: SolarLayoutFixture.load(reference.name))
        let gram = try #require(LayoutFit.groupGrams(
            LayoutFit.gridColumns(rows), y: rows.y, group: LayoutFit.fitMaskGroup(rows, clipKw: nil) { _ in 0 }, groups: 1
        ).first)

        let one = LayoutFit.fitFromGram(rows, gram: gram, clipKw: nil, planes: 1, starts: 3)
        expectPlanesClose(one.params, reference.onePlane, "\(reference.name) one plane")

        let two = LayoutFit.fitFromGram(rows, gram: gram, clipKw: nil, planes: 2, starts: 4)
        expectPlanesClose(two.params, reference.twoPlanes, "\(reference.name) two planes")
    }

    @Test(arguments: fixtureNames)
    func bootstrapReturnsTruthOnNoiselessFixtureRows(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let rows = try Self.rows(for: fixture)
        let truth = fixture.stages.poa.planes.map {
            LayoutPlane(azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.effectiveKw)
        }
        let boots = try LayoutFit.bootstrapRows(
            rows, clipKw: nil, best: truth, rounds: 2, rng: LayoutFit.seededRng(0))
        #expect(boots.count == 2)
        for boot in boots {
            #expect(boot.count == truth.count)
            for (plane, expected) in zip(boot, truth) {
                expectClose(plane.azimuth, expected.azimuth, 0.01, "\(name) bootstrap azimuth")
                expectClose(plane.tilt, expected.tilt, 0.01, "\(name) bootstrap tilt")
                expectClose(plane.effectiveKw, expected.effectiveKw, 0.001 * expected.effectiveKw, "\(name) bootstrap kW")
            }
        }
    }

    /// Fixture rows have too few per day for the 50-row CV folds, so the TypeScript reference
    /// reports one plane with NaN cross-validation; the Swift port follows the same path.
    @Test(arguments: fixtureNames)
    func planeCountFollowsTypeScriptOnFixtureRows(name: String) throws {
        let rows = try Self.rows(for: SolarLayoutFixture.load(name))
        let result = try LayoutFit.planeCountFromRows(
            rows, columns: LayoutFit.gridColumns(rows), clipKw: nil, rng: LayoutFit.seededRng(0))
        #expect(result.count == 1, "\(name) plane count")
        for count in 1 ... 3 {
            #expect(result.cvNrmse[count]?.isNaN == true, "\(name) cvNrmse \(count)")
        }
    }

    @Test func planeCountPropagatesCancellation() throws {
        let rows = try Self.rows(for: SolarLayoutFixture.load("east-west-year"))
        #expect(throws: Cancelled.self) {
            try LayoutFit.planeCountFromRows(
                rows, columns: LayoutFit.gridColumns(rows), clipKw: nil, rng: LayoutFit.seededRng(0),
                checkCancellation: { throw Cancelled() })
        }
    }

    @Test func gridHasTypeScriptComboCount() {
        // 36 azimuths for each of the 10 tilts above 0 degrees, plus one flat plane at 180 degrees (first).
        #expect(LayoutFit.combos.count == 361)
        #expect(LayoutFit.combos.first?.azimuth == 180 && LayoutFit.combos.first?.tilt == 0)
        #expect(LayoutFit.combos[1].azimuth == 0 && LayoutFit.combos[1].tilt == 5)
        #expect(LayoutFit.combos.last?.azimuth == 350 && LayoutFit.combos.last?.tilt == 50)
    }

    /// Reference `azimuthRange90` values from fit.test.ts.
    @Test func azimuthRangeUnwrapsAroundReference() {
        let wrapped = LayoutFit.azimuthRange90([350, 355, 5, 10], reference: 355)
        #expect(abs(wrapped.low - 350) <= 1)
        #expect(abs(wrapped.high - 10) <= 1)
        let south = LayoutFit.azimuthRange90([170, 180, 190], reference: 180)
        #expect(Int(south.low.rounded()) == 171)
        #expect(Int(south.high.rounded()) == 189)
    }

    /// Daylight rows from the fixture's recorded sun geometry and plane-of-array kW, all selected.
    private static func rows(for fixture: SolarLayoutFixture) throws -> LayoutFit.Rows {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: fixture.input.timeZone))
        let points = zip(fixture.stages.sun, fixture.stages.poa.kw).map { row, kw in
            let parts = calendar.dateComponents([.year, .month, .day], from: row.timestamp)
            return LayoutSeriesPoint(
                time: row.timestamp, kw: kw,
                sun: LayoutSunSample(
                    apparentZenith: row.apparentZenith, elevation: row.elevation, azimuth: row.azimuth,
                    dniExtra: row.dniExtra, ghi: row.ghi, dni: row.dni, dhi: row.dhi,
                    ambientFactor: row.ambientFactor),
                localDay: String(format: "%04ld-%02ld-%02ld", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0))
        }
        return LayoutFit.fitRows(LayoutSeries(points: points), selected: points.map { _ in true })
    }

    /// Compares packed [azimuth, tilt, kW] planes, both sides ordered by azimuth.
    private func expectPlanesClose(_ actual: [Double], _ expected: [Double], _ label: String) {
        #expect(actual.count == expected.count, "\(label) parameter count")
        guard actual.count == expected.count else { return }
        let found = Self.sortedByAzimuth(actual)
        let wanted = Self.sortedByAzimuth(expected)
        for (index, (plane, reference)) in zip(found, wanted).enumerated() {
            expectClose(plane[0], reference[0], 0.01, "\(label) azimuth \(index)")
            expectClose(plane[1], reference[1], 0.01, "\(label) tilt \(index)")
            expectClose(plane[2], reference[2], 0.001 * reference[2], "\(label) kW \(index)")
        }
    }

    private static func sortedByAzimuth(_ packed: [Double]) -> [[Double]] {
        stride(from: 0, to: packed.count, by: 3)
            .map { Array(packed[$0 ..< $0 + 3]) }
            .sorted { $0[0] < $1[0] }
    }

    private func expectClose(_ actual: Double, _ expected: Double, _ tolerance: Double, _ label: String) {
        #expect(abs(actual - expected) <= tolerance, "\(label): \(actual) vs \(expected)")
    }
}
