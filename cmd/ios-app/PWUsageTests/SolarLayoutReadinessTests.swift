import Foundation
@testable import PWUsage
import Testing

@Suite("Solar layout readiness")
struct SolarLayoutReadinessTests {
    private static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    private static let latitude = 43.4
    private static let longitude = -87.9

    /// Local noon (CDT, 17:00Z) production on `days` consecutive days from 2026-06-01, with zero
    /// night samples so the night baseline stays zero.
    private static func producing(days: Int) -> [(timestamp: Date, solarWh: Double)] {
        let start = Date(timeIntervalSince1970: 1_780_333_200) // 2026-06-01T17:00:00Z
        return (0 ..< days).flatMap { day -> [(timestamp: Date, solarWh: Double)] in
            let noon = start.addingTimeInterval(Double(day) * 86_400)
            return [(noon, 100), (noon.addingTimeInterval(10 * 3600), 0)]
        }
    }

    @Test func usesTheSitesTimeZone() {
        #expect(Self.chicago.identifier == "America/Chicago")
    }

    private static func readiness(_ samples: [(timestamp: Date, solarWh: Double)]) -> SolarLayoutReadiness {
        SolarLayoutDetector.readiness(samples: samples, latitude: latitude, longitude: longitude, timeZone: chicago)
    }

    @Test func requiresTheDetectorsProducingDayMinimum() {
        let short = Self.readiness(Self.producing(days: SolarLayoutDetector.minHistoryDays - 1))
        #expect(short.producingDays == 41)
        #expect(!short.isReady)
        #expect(short.daysNeeded == 1)

        let enough = Self.readiness(Self.producing(days: SolarLayoutDetector.minHistoryDays))
        #expect(enough.isReady)
        #expect(enough.daysNeeded == 0)
    }

    @Test func noHistoryIsNotReady() {
        let none = Self.readiness([])
        #expect(none.producingDays == 0)
        #expect(none.daysNeeded == SolarLayoutDetector.minHistoryDays)
    }

    @Test func countsSiteLocalDaysAcrossUTCMidnightAndFallBack() throws {
        func at(_ iso: String, _ solarWh: Double) throws -> (timestamp: Date, solarWh: Double) {
            try (#require(ISO8601DateFormatter().date(from: iso)), solarWh)
        }
        let zeros = try (0 ..< 12).map { try at(String(format: "2026-10-31T%02d:00:00Z", 6 + $0 / 4), 0) }
        // 04:00Z on 10-20 is still 10-19 in Chicago; 05:30Z and 06:30Z on 11-01 straddle the
        // fall-back change and are both 11-01 locally.
        let samples = try zeros + [
            at("2026-10-20T04:00:00Z", 50), at("2026-10-20T16:00:00Z", 50),
            at("2026-11-01T05:30:00Z", 50), at("2026-11-01T06:30:00Z", 50)]
        #expect(Self.readiness(samples).producingDays == 3)
    }

    @Test(arguments: SolarLayoutDetectorTests.fixtureNames)
    func agreesWithTheDetectorsRecordedHistoryDays(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let timeZone = try #require(TimeZone(identifier: fixture.input.timeZone))
        let readiness = SolarLayoutDetector.readiness(
            samples: SolarLayoutDetectorTests.samples(fixture), latitude: fixture.input.latitude,
            longitude: fixture.input.longitude, timeZone: timeZone)
        #expect(readiness.producingDays == fixture.result.historyDays)
        #expect(readiness.isReady == (fixture.result.status != "not-enough-history"))
    }

    @Test func detectorTypesTooFewProducingDays() throws {
        let result = try SolarLayoutDetector.detect(
            samples: Self.producing(days: 41), latitude: Self.latitude, longitude: Self.longitude,
            timeZone: Self.chicago, checkCancellation: {})
        #expect(result.status == .notEnoughHistory)
        #expect(result.shortfall == .fewProducingDays)
        #expect(result.reasons.isEmpty)
    }

    // MARK: - History outlook

    private static func result(
        _ status: DetectedSolarLayout.Status, _ confidence: String?, reasons: [String] = [],
        shortfall: DetectedSolarLayout.Shortfall? = nil
    ) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: status, confidence: confidence, reasons: reasons, planes: [], acClipKw: nil,
            historyDays: 60, clearDays: 10, firstDay: nil, lastDay: nil, shortfall: shortfall)
    }

    @Test func aForecastableLayoutIsUsable() {
        #expect(SolarLayoutDetector.historyOutlook(Self.result(.detected, "high")) == .usable)
        #expect(SolarLayoutDetector.historyOutlook(Self.result(.detected, "medium")) == .usable)
    }

    @Test(arguments: [
        result(.notEnoughHistory, nil, shortfall: .fewProducingDays),
        // Stored before shortfalls were recorded.
        result(.notEnoughHistory, nil),
        result(.lowConfidence, "low", reasons: ["few-clear-days"], shortfall: .fewClearSamples),
        result(.lowConfidence, "low", reasons: ["few-clear-days"], shortfall: .fewUsableClearDays),
        result(.lowConfidence, "low", reasons: ["few-clear-days"]),
        result(.lowConfidence, "low", reasons: ["azimuth-uncertain"]),
        result(.lowConfidence, "low", reasons: ["few-clear-days", "plane-at-tilt-limit"])
    ])
    func evidenceShortfallsMayBeHelpedByMoreHistory(result: DetectedSolarLayout) {
        #expect(SolarLayoutDetector.historyOutlook(result) == .moreHistoryMayHelp)
    }

    @Test(arguments: [
        result(.notEnoughHistory, nil, shortfall: .noDaylightProduction),
        result(.lowConfidence, "low", reasons: ["few-clear-days"], shortfall: .noPlaneFit),
        result(.lowConfidence, "low", reasons: ["few-clear-days", "location-mismatch"]),
        result(.lowConfidence, "low", reasons: ["plane-at-tilt-limit"]),
        result(.failed, nil)
    ])
    func otherProblemsNeedSomethingOtherThanHistory(result: DetectedSolarLayout) {
        #expect(SolarLayoutDetector.historyOutlook(result) == .needsOtherAction)
    }
}
