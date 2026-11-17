import Foundation
@testable import PWUsage
import Testing

extension SolarSystemHouseHealthTests {
    @Test("Finding categories deduplicate in order of appearance")
    func findingCategoriesDeduplicate() {
        let findings = [
            SolarHealthFinding(
                id: "1", kind: .shading, title: "Morning shade", detail: "Detail",
                clearDays: 20, confidence: .confident, meetsMinimumEvidence: true,
                season: .summer, azimuthFrom: 70, azimuthTo: 110),
            SolarHealthFinding(
                id: "2", kind: .shadingGrowth, title: "Shade grew", detail: "Detail",
                clearDays: 20, confidence: .confident, meetsMinimumEvidence: true,
                season: .winter, azimuthFrom: 140, azimuthTo: 170),
            SolarHealthFinding(
                id: "3", kind: .soiling, title: "Soiling", detail: "Detail",
                clearDays: 14, confidence: .initial, meetsMinimumEvidence: true,
                season: nil, azimuthFrom: nil, azimuthTo: nil),
            SolarHealthFinding(
                id: "4", kind: .stepFault, title: "Drop", detail: "Detail",
                clearDays: 10, confidence: .confident, meetsMinimumEvidence: true,
                season: nil, azimuthFrom: nil, azimuthTo: nil)
        ]

        #expect(SolarHealthFindingCategory.unique(in: findings) == [.shading, .soiling, .output])
    }

    @Test("Inspection initial state jumps to a shading finding's season and shaded hour")
    func inspectionInitialStateTargetsShadingFinding() throws {
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(label: "Main", installDate: nil, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "South", panelCount: 15, panelWatts: 400, azimuthDegrees: 180, tiltDegrees: 25)
            ])
        ])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        var horizon = Array(repeating: -Double.infinity, count: 36)
        for bin in 6 ... 11 {
            horizon[bin] = 45
        }
        let summerMask = ShadeMask(horizon: horizon, hotBins: [])
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 60,
            capacity: SolarHealthCapacity(
                site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 60),
            months: [],
            shade: [SolarSeasonShade(season: .summer, map: SolarShadeMap(summerMask), clearDays: 30)],
            dailyRatios: [])
        let result = SolarHealthResult(
            reference: reference, years: [year], referenceScale: 1.0, recomputedYears: [2026])
        let finding = SolarHealthFinding(
            id: "shade", kind: .shading, title: "Morning shade", detail: "Detail",
            clearDays: 30, confidence: .confident, meetsMinimumEvidence: true,
            season: .summer, azimuthFrom: 60, azimuthTo: 120)

        let state = SolarHouseHealthOverlay.initialState(
            for: finding, in: result, latitude: 43.4, longitude: -87.9)
        #expect(state.season == .summer)
        #expect(state.hourOfDay < 12.0)

        let overlay = SolarHouseHealthOverlay(
            report: nil, result: result, state: state, latitude: 43.4, longitude: -87.9)
        #expect(overlay.isSunShaded)
    }
}
