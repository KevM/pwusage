import Foundation
@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    @Test func savingStartSplitsTheHeadlineAndOffersTwoChoices() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        #expect(Self.normalized(verdict.title) == "Pool pump at 4:30 PM")
        #expect(verdict.subtitle == "About \(Self.money(1.89)) cheaper than now")
        #expect(verdict.choices.map(\.id) == [.recommended, .now])
        #expect(Self.normalized(verdict.choices[0].label) == "At 4:30 PM")
        #expect(verdict.choices[0].price == Self.money(3.38))
        #expect(verdict.choices[0].caption == "All Off-Peak")
        #expect(verdict.choices[1].label == "Now")
        #expect(verdict.choices[1].price == Self.money(5.27))
        #expect(verdict.choices[1].caption == "All Peak")
        #expect(verdict.chartTitle == "Distance to net zero")
        #expect(verdict.chartSubtitle.hasPrefix("kWh by "))
    }
    @Test func tomorrowStartSaysSoOnItsTile() throws {
        let comparison = Self.comparison(recommendedStart: Self.at(40.5))
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(Self.normalized(verdict.choices[0].label) == "Tomorrow at 4:30 PM")
    }

    @Test func nowBestIsOneChoice() throws {
        let comparison = Self.comparison(recommendedStart: Self.now)
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(verdict.title == "Pool pump now")
        #expect(verdict.subtitle == "No cheaper time today")
        #expect(verdict.choices.map(\.id) == [.now])
    }

    @Test func safetyWarningsRemainInTheSubtitle() throws {
        let (unsafe, now) = Self.unsafeNow()
        let warning = try Self.cycleVerdict(unsafe, now: now)
        #expect(warning.subtitle == "About \(Self.money(3.16)) more than now, but it won't leave On-Peak short")
        let (risky, otherNow) = Self.morningDip(safety: .noSafeStart(periodKey: "ON_PEAK"))
        let riskyVerdict = try Self.cycleVerdict(risky, now: otherNow)
        #expect(riskyVerdict.subtitle == "The least risky time, but a cloudy week could still leave On-Peak short")
    }
    @Test func barsReadHighestRateFirstFromTheProjectionEnd() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        #expect(verdict.rateBars.map(\.name) == ["Peak", "Off-Peak"])
        let peak = try #require(verdict.rateBars.first)
        #expect(peak.baselinePosition == 6)
        #expect(peak.now.runKwh == 14)
        #expect(peak.now.runLabel == "+14")
        #expect(peak.now.total == "20 owed")
        #expect(peak.recommended.runLabel == nil)
        #expect(verdict.rateBars[1].recommended.total == "4 banked")
    }
    @Test func smallRunsAndTotalsDoNotShowSignedZero() throws {
        let lanes = [Self.lane("Peak", start: 0.2, later: 0.1, startNow: 0.2)]
        let comparison = Self.comparison(lanes: lanes)
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        let state = try #require(verdict.rateBars.first?.recommended)
        #expect(abs(state.runKwh - 0.1) < 0.0001)
        #expect(state.runLabel == nil)
        #expect(state.total == "0")
    }

    @Test func barsUseProjectionEndValues() throws {
        let (comparison, now) = Self.morningDip()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        let bar = try #require(verdict.rateBars.first { $0.periodKey == "ON_PEAK" })
        #expect(bar.baselinePosition == -60)
        #expect(bar.recommended.total == "7 banked")
        #expect(bar.now.total == "60 banked")
    }
}
