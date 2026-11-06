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
        #expect(verdict.chartSubtitle.hasPrefix("kWh owed or banked by "))
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
        #expect(peak.now.total == "20 kWh owed")
        #expect(peak.recommended.runLabel == nil)
        #expect(verdict.rateBars[1].recommended.total == "4 kWh banked")
    }
    @Test func smallRunsAndTotalsDoNotShowSignedZero() throws {
        let lanes = [Self.lane("Peak", start: 0.2, later: 0.1, startNow: 0.2)]
        let comparison = Self.comparison(lanes: lanes)
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        let state = try #require(verdict.rateBars.first?.recommended)
        #expect(abs(state.runKwh - 0.1) < 0.0001)
        #expect(state.runLabel == nil)
        #expect(state.total == "0 kWh")
    }

    @Test func barsUseProjectionEndValues() throws {
        let (comparison, now) = Self.morningDip()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        let bar = try #require(verdict.rateBars.first { $0.periodKey == "ON_PEAK" })
        #expect(bar.baselinePosition == -60)
        #expect(bar.recommended.total == "7 kWh banked")
        #expect(bar.now.total == "60 kWh banked")
    }
    @Test func savingCaseBadgesAndLabelsBothChoices() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        let peak = try #require(verdict.rateBars.first { $0.name == "Peak" })
        let offPeak = try #require(verdict.rateBars.first { $0.name == "Off-Peak" })
        #expect(offPeak.recommended.badge == .cheapest)
        #expect(offPeak.recommended.badgeLabel == "Least expensive")
        #expect(peak.now.badge == .priciest)
        #expect(peak.now.badgeLabel == "Most expensive")
        let slot = try #require(verdict.slot)
        #expect(slot.periodKey == "Off-Peak")
        #expect(slot.extraKwh == 14)
        #expect(slot.label == "Save \(Self.money(1.89))")
    }
    @Test func cheaperBankedEnergyDoesNotCostTheLowestRateItsCheck() throws {
        let lanes = [Self.lane("Peak", start: 4, later: 1, startNow: -10),
                     Self.lane("Off-Peak", start: -371, later: -382, startNow: -371)]
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: Self.comparison(lanes: lanes),
                                                               unavailableReason: nil)))
        let offPeak = try #require(verdict.rateBars.first { $0.name == "Off-Peak" })
        let peak = try #require(verdict.rateBars.first { $0.name == "Peak" })
        #expect(offPeak.recommended.badge == .cheapest)
        #expect(offPeak.recommended.badgeLabel == "Least expensive")
        #expect(peak.recommended.badge == nil)
    }

    @Test func eachBarExplainsItselfForTheSelectedTime() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        let peak = try #require(verdict.rateBars.first { $0.name == "Peak" })
        let offPeak = try #require(verdict.rateBars.first { $0.name == "Off-Peak" })
        #expect(peak.now.explanation == "Peak: 6 kWh owed without this job, 20 kWh owed with it. "
            + "It's bought at 38¢/kWh.")
        #expect(peak.recommended.explanation == "Peak: 6 kWh owed. This job adds nothing here.")
        #expect(offPeak.recommended.explanation == "Off-Peak: 18 kWh banked without this job, 4 kWh banked with it. "
            + "It uses the bank, which costs only the 26¢/kWh credit.")
    }

    @Test func aRunThatOutgrowsItsBankSaysItBuysTheRest() throws {
        let lanes = [Self.lane("Peak", start: -6, later: -6, startNow: -6),
                     Self.lane("Off-Peak", start: 4, later: -10, startNow: 4)]
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: Self.comparison(lanes: lanes),
                                                               unavailableReason: nil)))
        let offPeak = try #require(verdict.rateBars.first { $0.name == "Off-Peak" })
        #expect(offPeak.recommended.explanation == "Off-Peak: 4 kWh banked without this job, 10 kWh owed with it. "
            + "It uses the bank, then buys the rest at 20¢/kWh.")
    }

    @Test func theDetailsLeadWithTheSelectedTime() {
        let later = CostBreakdown(title: "Later", total: "$1", lines: [], notes: [])
        let now = CostBreakdown(title: "Now", total: "$2", lines: [], notes: [])
        let lead = SmartShiftPresentation.breakdowns
        #expect(lead([later, now], .recommended).map(\.title) == ["Later", "Now"])
        #expect(lead([later, now], .now).map(\.title) == ["Now", "Later"])
        #expect(lead([now], .now).map(\.title) == ["Now"])
    }

    @Test func unsafeStatesShowNoGuidance() throws {
        let (unsafe, now) = Self.unsafeNow()
        let (risky, otherNow) = Self.morningDip(safety: .noSafeStart(periodKey: "ON_PEAK"))
        for verdict in [try Self.cycleVerdict(unsafe, now: now), try Self.cycleVerdict(risky, now: otherNow)] {
            #expect(verdict.slot == nil)
            #expect(verdict.rateBars.allSatisfy { $0.now.badge == nil && $0.recommended.badge == nil })
        }
    }

    @Test func noGainMeansNoSlot() throws {
        let lanes = [Self.lane("Peak", start: -6, later: -20, startNow: -20)]
        let comparison = Self.comparison(lanes: lanes)
        let verdict = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(verdict.slot == nil)
    }
}
