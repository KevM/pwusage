import Foundation
@testable import PWUsage
import SwiftUI
import Testing

@Suite("Solar System house health")
struct SolarSystemHouseHealthTests {
    private static let latitude = 43.4
    private static let longitude = -87.9

    private static func makeReference() throws -> SolarHealthReference {
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(label: "Main", installDate: nil, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "South", panelCount: 15, panelWatts: 400, azimuthDegrees: 180, tiltDegrees: 25)
            ])
        ])
        return try #require(SolarHealthReference(manual: manual, detected: nil))
    }

    private static func makeHorizon(shadedBins: ClosedRange<Int>, elevation: Double) -> [Double] {
        var horizon = Array(repeating: -Double.infinity, count: 36)
        for bin in shadedBins where bin >= 0 && bin < 36 {
            horizon[bin] = elevation
        }
        return horizon
    }

    @Test("Shaded faces darken for the selected season and time of day")
    func shadedFacesDarkenBySeasonAndTime() throws {
        let reference = try Self.makeReference()
        // Shade in summer when sun is in the east (azimuth 60..<120, bins 6...11) below 45° elevation.
        let summerMask = ShadeMask(horizon: Self.makeHorizon(shadedBins: 6 ... 11, elevation: 45), hotBins: [])
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 60,
            capacity: SolarHealthCapacity(
                site: 1.0, directions: [.init(azimuth: 180, factor: 1.0)], clearDays: 60),
            months: [],
            shade: [SolarSeasonShade(season: .summer, map: SolarShadeMap(summerMask), clearDays: 30)],
            dailyRatios: [])
        let result = SolarHealthResult(
            reference: reference, years: [year], referenceScale: 1.0, recomputedYears: [2026])

        let eastNormal = SIMD3<Double>(0.9, 0.0, 0.435)
        let westNormal = SIMD3<Double>(-0.9, 0.0, 0.435)

        // Summer morning (8:00 AM solar time): sun is in the east and below 45° -> shaded.
        let morningOverlay = SolarHouseHealthOverlay(
            report: nil, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 8.0, selectedYear: 2026),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(morningOverlay.isSunShaded)
        #expect(morningOverlay.isFaceShaded(normal: eastNormal))
        #expect(!morningOverlay.isFaceShaded(normal: westNormal))

        // Summer noon: sun is high in the south -> not shaded.
        let noonOverlay = SolarHouseHealthOverlay(
            report: nil, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2026),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(!noonOverlay.isSunShaded)
        #expect(!noonOverlay.isFaceShaded(normal: eastNormal))

        // Winter morning (8:00 AM): no winter shade mask -> not shaded.
        let winterOverlay = SolarHouseHealthOverlay(
            report: nil, result: result,
            state: SolarHouseHealthState(season: .winter, hourOfDay: 8.0, selectedYear: 2026),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(!winterOverlay.isSunShaded)

        // Shaded color is darker than unshaded color.
        let env = EnvironmentValues()
        let lit = SolarSystemColors.shaded(
            SolarSystemColors.panel, normal: eastNormal, sun: morningOverlay.sunVector, isShaded: false
        ).resolve(in: env)
        let dark = SolarSystemColors.shaded(
            SolarSystemColors.panel, normal: eastNormal, sun: morningOverlay.sunVector, isShaded: true
        ).resolve(in: env)
        #expect(dark.blue < lit.blue)
        #expect(dark.green < lit.green)

        let moment = try #require(
            SolarHouseHealthOverlay.firstShadedMoment(
                in: result, latitude: Self.latitude, longitude: Self.longitude))
        #expect(moment.season == .summer)
        #expect(moment.hourOfDay < 12.0)
    }

    @Test("Entered faces replace stand-in detected groups and respect year install dates")
    func enteredFacesReplaceDetectedAndRespectInstallDate() {
        let detected = SolarLayout(
            planes: [SolarLayoutPlane(azimuth: 200, tilt: 25, dcKwp: 6)],
            acClipKw: nil, confidence: .high, detectedAt: nil)
        let install2018 = Date(timeIntervalSince1970: 1_530_403_200) // 2018-07-01
        let install2024 = Date(timeIntervalSince1970: 1_719_792_000) // 2024-07-01
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(label: "Original", installDate: install2018, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "South", panelCount: 12, panelWatts: 300, azimuthDegrees: 180, tiltDegrees: 22)
            ]),
            ManualSolarSystem(label: "Addition", installDate: install2024, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "East", panelCount: 8, panelWatts: 420, azimuthDegrees: 90, tiltDegrees: 18)
            ])
        ])

        let input2025 = SolarSystemSceneInput(
            status: nil, layout: detected, isWaiting: false, manualLayout: manual,
            now: SolarHouseHealthOverlay.endOfYearDate(year: 2025))
        #expect(input2025.groups.count == 2)
        #expect(input2025.groups.map(\.panelCount) == [12, 8])
        #expect(input2025.groups.map(\.azimuth) == [180, 90])

        let input2020 = SolarSystemSceneInput(
            status: nil, layout: detected, isWaiting: false, manualLayout: manual,
            now: SolarHouseHealthOverlay.endOfYearDate(year: 2020))
        #expect(input2020.groups.count == 1)
        #expect(input2020.groups.first?.panelCount == 12)
    }

    private static func makeMultiYearResult(reference: SolarHealthReference) -> SolarHealthResult {
        let year2022 = SolarHealthYear(
            year: 2022, key: "k22", clearDays: 50,
            capacity: SolarHealthCapacity(
                site: 1.0,
                directions: [.init(azimuth: 90, factor: 1.0), .init(azimuth: 270, factor: 1.0)],
                clearDays: 50),
            months: [], shade: [], dailyRatios: [])
        let year2025 = SolarHealthYear(
            year: 2025, key: "k25", clearDays: 50,
            capacity: SolarHealthCapacity(
                site: 0.85,
                directions: [.init(azimuth: 90, factor: 0.80), .init(azimuth: 270, factor: 0.90)],
                clearDays: 50),
            months: [], shade: [], dailyRatios: [])
        return SolarHealthResult(
            reference: reference, years: [year2022, year2025], referenceScale: 1.0, recomputedYears: [2025])
    }

    private static func makeReport(isDirty: Bool) -> SolarHealthReport {
        SolarHealthReport(
            source: .manual, potentialVsActual: nil, healthScore: nil,
            shading: .init(entries: []),
            dirtLevel: .init(
                currentLossPercent: isDirty ? 6.0 : nil,
                lastRecoveredDay: isDirty ? nil : "2025-05-01",
                isActive: isDirty),
            changeOverTime: .init(
                years: [
                    .init(year: 2022, factor: 1.0, clearDays: 50),
                    .init(year: 2025, factor: 0.85, clearDays: 50)
                ],
                months: [], agingPercentPerYear: nil, expectedAgingPercentPerYear: nil,
                agingConfidence: nil, hasEnoughHistoryForTrend: true),
            dailyRatios: [], allFindings: [])
    }

    @Test("Year scrubber fades each face by its fitted direction factor")
    func yearScrubberFadesFacesByDirection() throws {
        let reference = try Self.makeReference()
        let result = Self.makeMultiYearResult(reference: reference)
        let report = Self.makeReport(isDirty: false)

        let overlay2025 = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2025),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(abs(overlay2025.panelOpacity(forAzimuth: 90) - 0.80) < 0.001)
        #expect(abs(overlay2025.panelOpacity(forAzimuth: 270) - 0.90) < 0.001)

        let overlay2022 = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2022),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(abs(overlay2022.panelOpacity(forAzimuth: 90) - 1.0) < 0.001)
        #expect(abs(overlay2022.panelOpacity(forAzimuth: 270) - 1.0) < 0.001)
    }

    @Test("Dirt tint tracks active soiling and clears on recovery or earlier years")
    func dirtTintTracksActiveSoilingAndClearsOnRecovery() throws {
        let reference = try Self.makeReference()
        let result = Self.makeMultiYearResult(reference: reference)
        let dirtyReport = Self.makeReport(isDirty: true)

        let activeOverlay = SolarHouseHealthOverlay(
            report: dirtyReport, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2025),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(activeOverlay.dirtAmount > 0)
        let tinted = SolarSystemColors.panel(dirtAmount: activeOverlay.dirtAmount)
        #expect(tinted.x > SolarSystemColors.panel.x)
        #expect(tinted.z < SolarSystemColors.panel.z)

        let historicalOverlay = SolarHouseHealthOverlay(
            report: dirtyReport, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2022),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(historicalOverlay.dirtAmount == 0)

        let cleanOverlay = SolarHouseHealthOverlay(
            report: Self.makeReport(isDirty: false), result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2025),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(cleanOverlay.dirtAmount == 0)
        #expect(SolarSystemColors.panel(dirtAmount: 0) == SolarSystemColors.panel)
    }

    @MainActor
    @Test("Demo session provides active soiling, summer shading and multi-year aging")
    func demoSessionProvidesSolarHealth() async throws {
        let suiteName = "demo-solar-health-\(UUID().uuidString)"
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let model = DemoSession.makeModel(suiteName: suiteName, timerInterval: nil, isDemo: true)
        let health = try #require(model.demoSolarHealth)
        try await eventually(timeout: .seconds(5)) {
            health.report != nil && !health.isRunning
        }
        let report = try #require(health.report)
        #expect(report.dirtLevel.isActive)
        #expect(report.changeOverTime.years.count == 3)
        #expect(report.shading.isShaded)
    }

    @Test("Default year matches last fitted report year when newest year has no capacity fit")
    func defaultYearMatchesFittedReportWhenNewestYearUnfitted() throws {
        let reference = try Self.makeReference()
        let baseResult = Self.makeMultiYearResult(reference: reference)
        let unfitted2026 = SolarHealthYear(
            year: 2026, key: "k26", clearDays: 2,
            capacity: nil, months: [], shade: [], dailyRatios: [])
        let result = SolarHealthResult(
            reference: reference,
            years: baseResult.years + [unfitted2026],
            referenceScale: 1.0,
            recomputedYears: [2026])
        let report = Self.makeReport(isDirty: true)

        let overlay = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: nil),
            latitude: Self.latitude, longitude: Self.longitude)
        #expect(overlay.yearFactor == 0.85)
        #expect(overlay.dirtAmount > 0)
    }

    private static func makeBaselineFixture(
        installDate: Date? = nil,
        extraYears: [SolarHealthYear] = []
    ) throws -> (report: SolarHealthReport, result: SolarHealthResult) {
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(label: "Main", installDate: installDate, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "East", panelCount: 10, panelWatts: 400, azimuthDegrees: 90, tiltDegrees: 25),
                ManualSolarFace(
                    label: "West", panelCount: 10, panelWatts: 400, azimuthDegrees: 270, tiltDegrees: 25)
            ])
        ])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let windowMonths = [1, 4, 7, 10].map { month in
            SolarHealthMonth(
                month: month,
                capacity: SolarHealthCapacity(
                    site: 1.05,
                    directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)],
                    clearDays: 10))
        }
        let year2023 = SolarHealthYear(
            year: 2023, key: "k23", clearDays: 40,
            capacity: SolarHealthCapacity(
                site: 1.05,
                directions: [.init(azimuth: 90, factor: 1.10), .init(azimuth: 270, factor: 1.00)],
                clearDays: 40),
            months: windowMonths, shade: [], dailyRatios: [])
        let year2025 = SolarHealthYear(
            year: 2025, key: "k25", clearDays: 40,
            capacity: SolarHealthCapacity(
                site: 0.995,
                directions: [.init(azimuth: 90, factor: 0.99), .init(azimuth: 270, factor: 1.00)],
                clearDays: 40),
            months: [], shade: [], dailyRatios: [])
        let result = SolarHealthResult(
            reference: reference,
            years: extraYears + [year2023, year2025],
            referenceScale: 1.0,
            recomputedYears: [2025])
        let now = Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: 2026, month: 1, day: 15)) ?? .now
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)
        return (report, result)
    }

    @Test("Entered-panel faces fade by their score against each face's baseline")
    func enteredPanelFacesFadeAgainstEachFaceBaseline() throws {
        let (report, result) = try Self.makeBaselineFixture()
        let overlay2025 = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2025),
            latitude: Self.latitude, longitude: Self.longitude)

        #expect(abs(overlay2025.panelOpacity(forAzimuth: 90) - 0.90) < 0.001)
        #expect(abs(overlay2025.panelOpacity(forAzimuth: 270) - 1.0) < 0.001)
    }

    @Test("Years before the baseline window do not fade")
    func yearsBeforeBaselineWindowDoNotFade() throws {
        let install2023 = Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: 2023, month: 1, day: 1)) ?? .now
        let year2021 = SolarHealthYear(
            year: 2021, key: "k21", clearDays: 40,
            capacity: SolarHealthCapacity(
                site: 0.70,
                directions: [.init(azimuth: 90, factor: 0.70), .init(azimuth: 270, factor: 0.70)],
                clearDays: 40),
            months: [], shade: [], dailyRatios: [])
        let (report, result) = try Self.makeBaselineFixture(
            installDate: install2023,
            extraYears: [year2021])
        let overlay2021 = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2021),
            latitude: Self.latitude, longitude: Self.longitude)

        #expect(overlay2021.panelOpacity(forAzimuth: 90) == 1.0)
    }

    @Test("Non-positive face baseline falls back to site factor without NaN or Inf")
    func nonPositiveFaceBaselineFallsBackToSiteFactor() throws {
        let manual = ManualSolarLayout(systems: [
            ManualSolarSystem(label: "Main", installDate: nil, inverterAcKw: nil, faces: [
                ManualSolarFace(
                    label: "East", panelCount: 10, panelWatts: 400, azimuthDegrees: 90, tiltDegrees: 25),
                ManualSolarFace(
                    label: "West", panelCount: 10, panelWatts: 400, azimuthDegrees: 270, tiltDegrees: 25)
            ])
        ])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let windowMonths = [1, 4, 7, 10].map { month in
            SolarHealthMonth(
                month: month,
                capacity: SolarHealthCapacity(
                    site: 1.00,
                    directions: [.init(azimuth: 90, factor: 0.0), .init(azimuth: 270, factor: 1.00)],
                    clearDays: 10))
        }
        let year2023 = SolarHealthYear(
            year: 2023, key: "k23", clearDays: 40,
            capacity: SolarHealthCapacity(
                site: 1.00,
                directions: [.init(azimuth: 90, factor: 0.0), .init(azimuth: 270, factor: 1.00)],
                clearDays: 40),
            months: windowMonths, shade: [], dailyRatios: [])
        let year2025 = SolarHealthYear(
            year: 2025, key: "k25", clearDays: 40,
            capacity: SolarHealthCapacity(
                site: 0.90,
                directions: [.init(azimuth: 90, factor: 0.80), .init(azimuth: 270, factor: 0.90)],
                clearDays: 40),
            months: [], shade: [], dailyRatios: [])
        let result = SolarHealthResult(
            reference: reference, years: [year2023, year2025], referenceScale: 1.0, recomputedYears: [2025])
        let now = Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: 2026, month: 1, day: 15)) ?? .now
        let report = SolarHealthClassifier.classify(result, manual: manual, now: now)
        let overlay = SolarHouseHealthOverlay(
            report: report, result: result,
            state: SolarHouseHealthState(season: .summer, hourOfDay: 12.0, selectedYear: 2025),
            latitude: Self.latitude, longitude: Self.longitude)

        let allFinite = overlay.directionFactors.allSatisfy(\.factor.isFinite)
        #expect(allFinite)
        #expect(overlay.directionFactors.count == 1)
        #expect(abs(overlay.panelOpacity(forAzimuth: 270) - 0.90) < 0.001)
    }
}
