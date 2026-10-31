import Foundation
@testable import PWUsage
import Testing

/// Fixtures small enough for the default Debug suite. The year fixtures run in
/// `SolarLayoutDetectorYearParityTests` (opt-in) because unoptimized detection on them takes minutes.
@Suite("Solar layout detector fixture parity")
struct SolarLayoutDetectorTests {
    /// `east-west-clipped-60d` is the default suite's clipped, two-plane, detected case.
    static let fixtureNames = ["east-west-30d", "east-west-clipped-60d", "south-shaded-100d"]

    @Test(arguments: fixtureNames)
    func matchesFixture(name: String) throws {
        try Self.checkFixture(name)
    }

    /// Runs detection once on fixture `name` and checks its result and stages against the recorded
    /// TypeScript values. Returns the detection's wall time in seconds.
    @discardableResult
    static func checkFixture(_ name: String) throws -> Double {
        let fixture = try SolarLayoutFixture.load(name)
        let started = ProcessInfo.processInfo.systemUptime
        let outcome = try Self.detectStages(fixture)
        let seconds = ProcessInfo.processInfo.systemUptime - started
        checkResult(name, outcome.result, fixture.result)
        try checkStages(name, outcome.stages, fixture)
        return seconds
    }

    static func checkResult(_ name: String, _ result: DetectedSolarLayout, _ expected: SolarLayoutFixture.Result) {
        #expect(result.status.rawValue == expected.status, "\(name) status")
        #expect(result.confidence == expected.confidence, "\(name) confidence")
        #expect(result.reasons == expected.reasons, "\(name) reasons")
        #expect(result.historyDays == expected.historyDays, "\(name) historyDays")
        #expect(result.clearDays == expected.clearDays, "\(name) clearDays")
        #expect(result.firstDay == expected.firstDay, "\(name) firstDay")
        #expect(result.lastDay == expected.lastDay, "\(name) lastDay")
        #expect(result.planes.count == expected.planes.count, "\(name) plane count")
        Self.expectRelative(result.acClipKw, expected.acClipKw, 0.01, "\(name) acClipKw")

        for (index, (plane, want)) in zip(result.planes, expected.planes).enumerated() {
            Self.expectAngle(plane.azimuth, want.azimuth, 0.5, "\(name) plane \(index) azimuth")
            Self.expectClose(plane.tilt, want.tilt, 0.5, "\(name) plane \(index) tilt")
            Self.expectClose(plane.dcKwp, want.dcKwp, 0.01 * want.dcKwp, "\(name) plane \(index) dcKwp")
            Self.expectClose(
                plane.effectiveKw, want.effectiveKw, 0.01 * want.effectiveKw, "\(name) plane \(index) effectiveKw")
            #expect(plane.azimuthRange90.count == 2, "\(name) plane \(index) azimuthRange90 count")
            #expect(plane.tiltRange90.count == 2, "\(name) plane \(index) tiltRange90 count")
            for (got, wanted) in zip(plane.azimuthRange90, want.azimuthRange90) {
                Self.expectAngle(got, wanted, 0.5, "\(name) plane \(index) azimuthRange90")
            }
            for (got, wanted) in zip(plane.tiltRange90, want.tiltRange90) {
                Self.expectClose(got, wanted, 0.5, "\(name) plane \(index) tiltRange90")
            }
        }
    }

    /// Stage values replayed from the fixture's `stages`: selection and fit intermediates that the
    /// result does not carry.
    static func checkStages(
        _ name: String, _ stages: SolarLayoutDetectionStages, _ fixture: SolarLayoutFixture
    ) throws {
        let selection = try #require(fixture.stages.selection)

        #expect(stages.producingDays == selection.producingDays, "\(name) producingDays")
        #expect(stages.clearDays == selection.clearDays, "\(name) selection clearDays")
        #expect(stages.selectedRows == selection.selectedRows, "\(name) selectedRows")
        Self.expectRelative(stages.clipKw, selection.clipKw, 1e-9, "\(name) clipKw")

        #expect(stages.shading.count == selection.shading.count, "\(name) shading count")
        for (index, (segment, want)) in zip(stages.shading, selection.shading).enumerated() {
            Self.expectClose(segment.azimuthFrom, want.azimuthFrom, 1e-9, "\(name) shading \(index) from")
            Self.expectClose(segment.azimuthTo, want.azimuthTo, 1e-9, "\(name) shading \(index) to")
            Self.expectClose(segment.belowElevation, want.belowElevation, 1e-9, "\(name) shading \(index) elevation")
        }

        guard let fit = fixture.stages.fit else {
            #expect(stages.planeCount == nil, "\(name) fit should not run")
            return
        }
        #expect(stages.planeCount == fit.planeCount, "\(name) planeCount")
        // The exporter rejects non-finite cvNrmse, so every recorded value is finite.
        for count in 1 ... 3 {
            let got = stages.cvNrmse[count] ?? .nan
            Self.expectClose(got, fit.cvNrmse[count] ?? .nan, 1e-6, "\(name) cvNrmse \(count)")
        }
        #expect(stages.bestPlanes.count == fit.bestPlanes.count, "\(name) best plane count")
        for (index, (plane, want)) in zip(stages.bestPlanes, fit.bestPlanes).enumerated() {
            Self.expectAngle(plane.azimuth, want.azimuth, 0.01, "\(name) best \(index) azimuth")
            Self.expectClose(plane.tilt, want.tilt, 0.01, "\(name) best \(index) tilt")
            Self.expectClose(plane.effectiveKw, want.effectiveKw, 0.001 * want.effectiveKw, "\(name) best \(index) kW")
        }
    }

    @Test func yearOfZerosIsNotEnoughHistory() throws {
        let start = Date(timeIntervalSince1970: 1_735_689_600)
        let samples = (0 ..< 365 * 288).map { index in
            (timestamp: start.addingTimeInterval(Double(index) * 300), solarWh: 0.0)
        }
        let timeZone = try #require(TimeZone(identifier: "America/Chicago"))
        let result = try SolarLayoutDetector.detect(
            samples: samples, latitude: 43.4, longitude: -87.9, timeZone: timeZone, checkCancellation: {})

        #expect(result.status == .notEnoughHistory)
        #expect(result.confidence == nil)
        #expect(result.planes.isEmpty)
        #expect(result.historyDays == 0)
        #expect(result.firstDay == nil)
        #expect(result.lastDay == nil)
    }

    @Test func cancellationStopsDetection() throws {
        let fixture = try SolarLayoutFixture.load("south-shaded-100d")
        let timeZone = try #require(TimeZone(identifier: fixture.input.timeZone))
        var calls = 0
        #expect(throws: CancellationError.self) {
            _ = try SolarLayoutDetector.detect(
                samples: Self.samples(fixture), latitude: fixture.input.latitude,
                longitude: fixture.input.longitude, timeZone: timeZone,
                checkCancellation: {
                    calls += 1
                    if calls == 3 { throw CancellationError() }
                })
        }
        #expect(calls == 3)
    }

    @Test func forecastLayoutServesOnlyHighOrMediumConfidence() {
        let detectedAt = Date(timeIntervalSince1970: 1_800_000_000)
        func result(_ status: DetectedSolarLayout.Status, _ confidence: String?) -> DetectedSolarLayout {
            DetectedSolarLayout(
                status: status, confidence: confidence, reasons: [],
                planes: [.init(
                    azimuth: 90, tilt: 20, dcKwp: 5, effectiveKw: 4.25,
                    azimuthRange90: [89, 91], tiltRange90: [19, 21])],
                acClipKw: 4.5, historyDays: 365, clearDays: 200,
                firstDay: "2025-11-01", lastDay: "2026-10-31")
        }

        let high = SolarLayoutDetector.forecastLayout(result(.detected, "high"), detectedAt: detectedAt)
        #expect(high == SolarLayout(
            planes: [SolarLayoutPlane(azimuth: 90, tilt: 20, dcKwp: 5)], acClipKw: 4.5,
            confidence: .high, detectedAt: detectedAt))
        let medium = SolarLayoutDetector.forecastLayout(result(.detected, "medium"), detectedAt: detectedAt)
        #expect(medium?.confidence == .medium)
        #expect(SolarLayoutDetector.forecastLayout(result(.lowConfidence, "low"), detectedAt: detectedAt) == nil)
        #expect(SolarLayoutDetector.forecastLayout(result(.detected, "low"), detectedAt: detectedAt) == nil)
        #expect(SolarLayoutDetector.forecastLayout(result(.notEnoughHistory, nil), detectedAt: detectedAt) == nil)
    }

    // MARK: - Helpers

    static func samples(_ fixture: SolarLayoutFixture) -> [(timestamp: Date, solarWh: Double)] {
        fixture.input.solarWh.enumerated().map { index, energyWh in
            (timestamp: fixture.input.start.addingTimeInterval(Double(index) * 300), solarWh: Double(energyWh))
        }
    }

    static func detectStages(_ fixture: SolarLayoutFixture) throws -> SolarLayoutDetectorOutcome {
        let timeZone = try #require(TimeZone(identifier: fixture.input.timeZone))
        return try SolarLayoutDetector.detectWithStages(
            samples: samples(fixture), latitude: fixture.input.latitude,
            longitude: fixture.input.longitude, timeZone: timeZone, checkCancellation: {})
    }

    static func expectClose(_ got: Double, _ want: Double, _ tolerance: Double, _ label: String) {
        #expect(abs(got - want) <= tolerance, "\(label): got \(got), want \(want)")
    }

    static func expectRelative(_ got: Double?, _ want: Double?, _ tolerance: Double, _ label: String) {
        switch (got, want) {
        case (nil, nil):
            return
        case let (gotValue?, wantValue?):
            #expect(abs(gotValue - wantValue) <= tolerance * max(abs(wantValue), 1e-12),
                    "\(label): got \(gotValue), want \(wantValue)")
        default:
            Issue.record("\(label): got \(String(describing: got)), want \(String(describing: want))")
        }
    }

    /// Angular distance in degrees, wrapping at 360.
    static func expectAngle(_ got: Double, _ want: Double, _ tolerance: Double, _ label: String) {
        let difference = abs((got - want + 540).truncatingRemainder(dividingBy: 360) - 180)
        #expect(difference <= tolerance, "\(label): got \(got), want \(want)")
    }
}

/// Year-sized fixtures: unoptimized detection takes minutes, so this suite runs only when
/// PWUSAGE_SOLAR_SLOW_PARITY=1 reaches the test process. xcodebuild forwards only TEST_RUNNER_-prefixed
/// variables, so run: TEST_RUNNER_PWUSAGE_SOLAR_SLOW_PARITY=1 PWUSAGE_TEST_TIMEOUT_SECONDS=1800
/// ./run-tests.sh PWUsageTests/SolarLayoutDetectorYearParityTests
@Suite(
    "Solar layout detector year parity (opt-in)",
    .enabled(if: ProcessInfo.processInfo.environment["PWUSAGE_SOLAR_SLOW_PARITY"] == "1"))
struct SolarLayoutDetectorYearParityTests {
    static let fixtureNames = ["east-west-year", "south-clipped-year"]

    /// One detection per fixture checks its result and stages and prints its wall time for the timing record.
    @Test(arguments: fixtureNames)
    func matchesFixture(name: String) throws {
        let seconds = try SolarLayoutDetectorTests.checkFixture(name)
        print("SOLAR_LAYOUT_DETECT_TIMING \(name) \(String(format: "%.2f", seconds)) s")
    }
}
