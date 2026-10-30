import Foundation
@testable import PWUsage
import Testing

@Suite("Forecast.Solar interval conversion")
struct ForecastSolarConversionTests {
    private typealias Day = ForecastSolarFixture.Day
    private static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt

    private static func date(_ text: String, in zone: TimeZone = chicago) throws -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return try #require(formatter.date(from: text))
    }

    private static func intervals(
        _ days: [Day],
        now: String,
        clip: Double? = nil,
        planes: Int = 1
    ) throws -> [SolarForecastInterval] {
        let estimate = try ForecastSolarFixture.estimate(days: days)
        return try ForecastSolarForecast.intervals(
            estimates: Array(repeating: estimate, count: planes), acClipKw: clip,
            siteTimeZone: chicago, now: date(now))
    }

    private static func assertContiguous(_ intervals: [SolarForecastInterval]) {
        for pair in zip(intervals, intervals.dropFirst()) {
            #expect(pair.0.periodEnd == pair.1.periodStart)
        }
        #expect(intervals.allSatisfy { $0.periodEnd.timeIntervalSince($0.periodStart) == 3600 })
        #expect(intervals.allSatisfy { $0.cautiousPowerKw == nil })
    }

    @Test("A normal day pair gives 48 contiguous hours with zero nights and conserved energy")
    func normalPair() throws {
        let days = [Day.normal("2026-10-28"), .normal("2026-10-29")]
        let result = try Self.intervals(days, now: "2026-10-28 09:30:00")
        #expect(result.count == 48)
        Self.assertContiguous(result)
        #expect(result.first?.periodStart == (try Self.date("2026-10-28 00:00:00")))
        #expect(result.last?.periodEnd == (try Self.date("2026-10-30 00:00:00")))
        #expect(result[0].powerKw == 0)
        #expect(result[23].powerKw == 0)
        let total = try result.reduce(0) { try $0 + $1.energyKwh() }
        let expected = days.reduce(0) { $0 + $1.totalWh } / 1000
        #expect(abs(total - expected) / expected < 0.001)
    }

    @Test("Spring-forward and fall-back day pairs give 47 and 49 hours")
    func daylightSaving() throws {
        let spring = try Self.intervals([.normal("2026-03-08"), .normal("2026-03-09")], now: "2026-03-08 12:00:00")
        #expect(spring.count == 47)
        Self.assertContiguous(spring)
        let fall = try Self.intervals([.normal("2026-11-01"), .normal("2026-11-02")], now: "2026-11-01 12:00:00")
        #expect(fall.count == 49)
        Self.assertContiguous(fall)
    }

    @Test("A period's energy is split across the hours it spans; the sunrise marker adds nothing")
    func sunriseSplit() throws {
        let today = Day(date: "2026-10-28", periods: [("06:45:37", 0), ("07:15:37", 300), ("08:00:00", 100)])
        let tomorrow = Day(date: "2026-10-29", periods: [("06:46:00", 0), ("07:00:00", 50)])
        let result = try Self.intervals([today, tomorrow], now: "2026-10-28 05:00:00")
        #expect(abs(result[6].powerKw * 1000 - 143.833) < 0.001)
        #expect(abs(result[7].powerKw * 1000 - (156.167 + 100)) < 0.001)
        #expect(result[5].powerKw == 0)
    }

    @Test("Planes are summed and an AC limit caps every hour")
    func planesAndClip() throws {
        let days = [Day.normal("2026-10-28", scale: 4), .normal("2026-10-29", scale: 4)]
        let single = try Self.intervals(days, now: "2026-10-28 09:00:00")
        let double = try Self.intervals(days, now: "2026-10-28 09:00:00", planes: 2)
        for (one, two) in zip(single, double) {
            #expect(abs(two.powerKw - one.powerKw * 2) < 1e-9)
        }
        let clipped = try Self.intervals(days, now: "2026-10-28 09:00:00", clip: 3, planes: 2)
        #expect(clipped.allSatisfy { $0.powerKw <= 3 })
        #expect(clipped.contains { $0.powerKw == 3 })
    }

    @Test("Only today's data is incomplete coverage")
    func onlyToday() {
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try Self.intervals([.normal("2026-10-28")], now: "2026-10-28 09:00:00")
        }
    }

    @Test("A provider timezone that differs from the site's is rejected")
    func mismatchedSiteTimeZone() throws {
        let estimate = try ForecastSolarFixture.estimate(
            timezone: "America/Denver", days: [.normal("2026-10-28"), .normal("2026-10-29")])
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try ForecastSolarForecast.intervals(
                estimates: [estimate], acClipKw: nil, siteTimeZone: Self.chicago,
                now: Self.date("2026-10-28 09:00:00"))
        }
    }

    @Test("The site's calendar decides today, not the device's")
    func siteCalendarNotDevice() throws {
        // 23:30 in Chicago is already the next morning in Tokyo; today is still the 28th at the site.
        let tokyoMorning = try Self.date("2026-10-29 13:30:00", in: TimeZone(identifier: "Asia/Tokyo") ?? .gmt)
        let estimate = try ForecastSolarFixture.estimate(days: [.normal("2026-10-28"), .normal("2026-10-29")])
        let result = try ForecastSolarForecast.intervals(
            estimates: [estimate], acClipKw: nil, siteTimeZone: Self.chicago, now: tokyoMorning)
        #expect(result.first?.periodStart == (try Self.date("2026-10-28 00:00:00")))
        #expect(result.count == 48)
    }
}
