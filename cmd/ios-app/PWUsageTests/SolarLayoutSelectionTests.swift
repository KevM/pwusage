import Foundation
@testable import PWUsage
import Testing

@Suite("Solar layout selection parity")
struct SolarLayoutSelectionTests {
    static let fixtureNames = ["east-west-30d", "east-west-year", "south-clipped-year", "south-shaded-100d"]

    @Test(arguments: fixtureNames)
    func producingDaysAndClipMatchFixture(name: String) throws {
        let fixture = try SolarLayoutFixture.load(name)
        let expected = try #require(fixture.stages.selection)
        let series = try Self.series(for: fixture)

        let producingDays = Set(series.filter { $0.kw > 0 }.map(\.localDay)).count
        #expect(producingDays == expected.producingDays, "\(name) producingDays")

        // The reference only reaches clip detection with at least 42 producing days (detect.ts MIN_HISTORY_DAYS).
        guard expected.producingDays >= 42 else { return }
        let clip = detectClip(series)
        if let expectedClip = expected.clipKw {
            let limit = try #require(clip?.limitKw, "\(name) expected a clip plateau")
            #expect(abs(limit - expectedClip) <= 1e-6, "\(name) clipKw \(limit) vs \(expectedClip)")
        } else {
            #expect(clip == nil, "\(name) unexpected clip plateau")
        }
    }

    /// Reference values from the TypeScript `detectClip` and `envelopeClear` run on the same fixture input.
    @Test(arguments: clipReferences)
    func detectClipMatchesReference(reference: ClipReference) throws {
        let series = try Self.series(for: SolarLayoutFixture.load(reference.name))
        let clip = detectClip(series)
        guard let limitKw = reference.limitKw else {
            #expect(clip == nil, "\(reference.name) unexpected clip plateau")
            return
        }
        let found = try #require(clip)
        #expect(abs(found.limitKw - limitKw) <= 1e-9, "\(reference.name) limitKw")
        #expect(found.intervals == reference.intervals, "\(reference.name) intervals")
        #expect(found.days == reference.days, "\(reference.name) days")
    }

    @Test(arguments: envelopeReferences)
    func envelopeClearMatchesReference(reference: EnvelopeReference) throws {
        let series = try Self.series(for: SolarLayoutFixture.load(reference.name))
        let mask = envelopeClear(series, peakKw: 5)
        let indices = mask.indices.filter { mask[$0] }
        #expect(indices.count == reference.clearCount, "\(reference.name) clear count")
        #expect(indices.reduce(0, +) == reference.indexSum, "\(reference.name) clear index sum")
    }

    struct ClipReference: Sendable {
        let name: String
        let limitKw: Double?
        let intervals: Int
        let days: Int
    }

    struct EnvelopeReference: Sendable {
        let name: String
        let clearCount: Int
        let indexSum: Int
    }

    static let clipReferences = [
        ClipReference(name: "east-west-30d", limitKw: 7.651, intervals: 41, days: 5),
        ClipReference(name: "east-west-year", limitKw: nil, intervals: 0, days: 0),
    ]

    static let envelopeReferences = [
        EnvelopeReference(name: "east-west-30d", clearCount: 2765, indexSum: 12_669_175),
        EnvelopeReference(name: "east-west-year", clearCount: 26667, indexSum: 1_493_046_043),
    ]

    @Test func seriesKeepsDSTSlots() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try #require(TimeZone(identifier: "UTC"))
        // America/Chicago falls back at 02:00 CDT on 2026-11-01, so the local day is 25 hours (300 slots)
        // from 00:00 CDT (05:00 UTC) to 00:00 CST on 2026-11-02.
        let start = try #require(utc.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 5)))
        let samples = (0 ..< 300).map { index in
            (timestamp: start.addingTimeInterval(Double(index) * 300), solarWh: 0.0)
        }
        let series = layoutSeries(
            samples: samples, latitude: 43.4, longitude: -87.9,
            timeZone: try #require(TimeZone(identifier: "America/Chicago")))

        #expect(series.count == 300)
        #expect(Set(series.map(\.time)).count == 300)
        #expect(zip(series, series.dropFirst()).allSatisfy { pair in abs(pair.1.time.timeIntervalSince(pair.0.time) - 300) < 1e-6 })
        #expect(series.allSatisfy { $0.localDay == "2026-11-01" })
        // Both 01:00-01:59 hours exist: CDT before the fall-back, CST after it.
        let repeatedHour = series.filter { $0.time >= start.addingTimeInterval(3600) && $0.time < start.addingTimeInterval(3 * 3600) }
        #expect(repeatedHour.count == 24)
    }

    @Test func quantileAndMedianIgnoreNonFiniteValues() {
        #expect(quantile([3, .nan, 1, 2, 4], 0.5) == 2.5)
        #expect(median([1, 2, 3]) == 2)
        #expect(quantile([], 0.5).isNaN)
    }

    @Test func shadeSummaryMergesContiguousBins() {
        var horizon = [Double](repeating: 10, count: 36)
        horizon[0] = -.infinity
        for bin in 18 ..< 36 { horizon[bin] = 30 }
        let mask = ShadeMask(horizon: horizon, hotBins: [])
        #expect(mask.summary() == [
            ShadeSegment(azimuthFrom: 10, azimuthTo: 180, belowElevation: 10),
            ShadeSegment(azimuthFrom: 180, azimuthTo: 360, belowElevation: 30),
        ])
    }

    @Test func shadeMaskUsesHorizonAndHotBins() {
        var horizon = [Double](repeating: 0, count: 36)
        horizon[9] = 20
        let mask = ShadeMask(horizon: horizon, hotBins: [ShadeHotBin(azimuth: 200, elevation: 60)])
        #expect(mask.shaded(azimuth: 95, elevation: 15))
        #expect(!mask.shaded(azimuth: 95, elevation: 25))
        #expect(mask.shaded(azimuth: 205, elevation: 62))
        #expect(!mask.shaded(azimuth: 205, elevation: 65))
    }

    /// The fixture's 5-minute Float32 production, placed on its UTC grid.
    private static func series(for fixture: SolarLayoutFixture) throws -> LayoutSeries {
        let start = fixture.input.start.timeIntervalSince1970
        let samples = fixture.input.solarWh.enumerated().map { index, wh in
            (timestamp: Date(timeIntervalSince1970: start + Double(index) * 300), solarWh: Double(wh))
        }
        return layoutSeries(
            samples: samples, latitude: fixture.input.latitude, longitude: fixture.input.longitude,
            timeZone: try #require(TimeZone(identifier: fixture.input.timeZone)))
    }
}
