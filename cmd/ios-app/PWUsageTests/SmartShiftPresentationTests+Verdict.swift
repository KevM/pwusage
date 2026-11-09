import Foundation
@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    @Test func laterStartTomorrowSaysSo() throws {
        let comparison = Self.comparison(recommendedStart: Self.at(40.5))
        let verdict = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(Self.normalized(Self.legacyHeadline(verdict))
            == "Charge the car tomorrow at 4:30 PM: about \(Self.money(1.89)) cheaper than now")
        #expect(Self.normalized(verdict.why).contains("Tomorrow at 4:30 PM it"))
    }

    @Test func unobservedBalanceNote() throws {
        let comparison = Self.comparison(hasUnobservedBalance: true)
        let ready = try Self.verdict(
            Self.make(result: .init(comparison: comparison, unavailableReason: nil), forecast: .ready))
        #expect(ready.notes == [.unobservedBalance])
        let none = try Self.verdict(
            Self.make(result: .init(comparison: comparison, unavailableReason: nil), forecast: .none))
        #expect(none.notes == [.noForecast(usesHistory: false), .unobservedBalance])
    }

    @Test func fallbackCopyUsesBankTerms() {
        #expect(SmartShiftPresentation.unobservedBalanceNote
            == "Some rate periods have no bank yet, so they're priced at the full rate.")
        #expect(SmartShiftPresentation.incompleteBalanceMessage
            == "Some rate periods or bank data are missing, so costs can't be compared.")
    }

    @Test func forecastStatesBecomeNotes() throws {
        #expect(try Self.verdict(Self.make(forecast: .ready)).notes.isEmpty)
        #expect(try Self.verdict(Self.make(forecast: .unusable("The forecast provider is limiting requests."))).notes
            == [.forecastState("The forecast provider is limiting requests.")])
    }

    @Test func noJobsWithoutProfile() {
        #expect(Self.make(profile: nil).content == .noJobs)
    }

    @Test func staleDataBlocks() throws {
        let message = try Self.blocked(Self.make(refreshUnavailable: true))
        #expect(message.contains("refresh failed"))
        let stale = try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .staleBalance)))
        #expect(stale.contains("older than one hour"))
    }

    @Test func missingRatePlanBlocks() throws {
        #expect(try Self.blocked(Self.make(timing: Self.timing(hasTariff: false)))
            .localizedCaseInsensitiveContains("rate plan"))
        #expect(try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .missingTariff)))
            .localizedCaseInsensitiveContains("rate plan"))
        #expect(try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .incompleteBalance)))
            .contains("missing"))
    }

    @Test func billingCycleCrossingBlocks() throws {
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14,
                               durationHours: 5.9, carSettings: nil)
        let crossing = try Self.blocked(Self.make(profile: pump,
                                                  result: .init(comparison: nil, unavailableReason: .noFittingRun),
                                                  billingCycleEnd: Self.now.addingTimeInterval(3600)))
        #expect(crossing.contains("beyond the current billing cycle"))
        #expect(!crossing.localizedCaseInsensitiveContains("cushion"))
        let tooLong = try Self.blocked(
            Self.make(profile: pump, result: .init(comparison: nil, unavailableReason: .noFittingRun)))
        #expect(tooLong == "This job is longer than the time Smart Shift can compare right now.")
    }
    @Test func whyLineNamesPeriods() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        #expect(Self.normalized(verdict.why)
            == "Starting now runs during Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 4:30 PM it uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }

    @Test func whyLineExplainsRatesAndClaimsOnlyBanksTheRunDrawsFrom() throws {
        // The owner's Sunday: Off-Peak all day and owed; tomorrow On-Peak 08:00–20:00 banks solar
        // from +5 to +33. The car (40 kWh, 4.4 h) at 16:30 tomorrow puts 31.5 kWh into On-Peak's
        // bank and buys the last 8.5 kWh after 20:00 at the Off-Peak rate.
        let now = Self.at(12 + 38.0 / 60)
        let spans = [RateSpan(0, 32, "Off-Peak", 0.132, 0.05), RateSpan(32, 44, "On-Peak", 0.30, 0.072),
                     RateSpan(44, 48, "Off-Peak", 0.132, 0.05)]
        let segments = spans.map {
            LoadTimingTariffSegment(start: Self.at($0.start), end: Self.at($0.end), periodKey: $0.key,
                                    name: $0.key, buyRate: $0.buy, sellRate: $0.sell)
        }
        let periods = [("Off-Peak", -66.0, 0.132, 0.05), ("On-Peak", 5.0, 0.30, 0.072)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil,
                                nextCheaperPhrase: nil,
                                nextStartPhraseByKey: [:])
        func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: start,
                                  recommended: [.init(date: now, kwh: start), .init(date: Self.horizonEnd, kwh: later)],
                                  startNow: [.init(date: now, kwh: start), .init(date: Self.horizonEnd, kwh: startNow)])
        }
        let comparison = Estimator.Comparison(
            costNow: 5.27, recommendedStart: Self.at(40.5), recommendedEnd: Self.at(40.5 + 40.0 / 9),
            recommendedCost: 3.38,
            savings: 1.89, bestAlternativeSavings: 1.89, estimatedSolarContribution: 0, horizonStart: now,
            horizonEnd: Self.horizonEnd, evaluatedStarts: [now, Self.at(40.5)], assumptions: [],
            hasUnobservedBalance: false,
            lanes: [lane("Off-Peak", start: -66, later: -93, startNow: -124.5),
                    lane("On-Peak", start: 5, later: 1.5, startNow: 33)],
            periodSwitches: [Self.at(32), Self.at(44)])
        let screen = SmartShiftPresentation.make(
            profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false,
            inputs: .init(timing: timing, now: now, billingCycleEnd: Self.at(480),
                          currencyCode: "USD", timeZone: "UTC"))
        let why = Self.normalized(try Self.verdict(screen).why)
        #expect(!why.contains("Off-Peak bank"))
        #expect(why
            == "Starting now runs during Off-Peak, where you have no bank, so it's bought at \(Self.rate(0.132)). "
            + "Tomorrow at 4:30 PM it mostly uses your On-Peak bank, projected at +33 kWh by "
            + "\(Self.shortDate(Self.horizonEnd)), "
            + "giving up \(Self.rate(0.072)) in credit.")
    }

    @Test func whyLineSaysMostlyWhenTheLaterRunSpansPeriods() throws {
        // 15:00 + 5.9 h puts 1.5 h in Peak and the rest in Off-Peak.
        let verdict = try Self.verdict(Self.make(profile: Self.pump, result: .init(
            comparison: Self.comparison(recommendedStart: Self.at(15)), unavailableReason: nil)))
        #expect(Self.normalized(verdict.why)
            == "Starting now runs during Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 3:00 PM it mostly uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }

    @Test func whyLineWhenBothRunsCrossTheSamePeriodsNamesTheShift() throws {
        // 24 kWh over 20 h: starting now (08:30) spends 8 h in Peak, starting at 11:00 only 5.5 h.
        // Both runs cross Peak then Off-Peak, and no solar is involved.
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 24,
                               durationHours: 20, carSettings: nil)
        let comparison = Estimator.Comparison(
            costNow: 4.37, recommendedStart: Self.at(11), recommendedEnd: Self.at(31), recommendedCost: 4.01,
            savings: 0.36,
            bestAlternativeSavings: 0.36, estimatedSolarContribution: 0, horizonStart: Self.now,
            horizonEnd: Self.horizonEnd,
            evaluatedStarts: [Self.now, Self.at(11)], assumptions: [], hasUnobservedBalance: false,
            lanes: Self.laterLanes, periodSwitches: [Self.at(16.5)])
        let verdict = try Self.verdict(
            Self.make(profile: pump, result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(!verdict.why.localizedCaseInsensitiveContains("solar"))
        #expect(Self.normalized(verdict.why)
            == "Starting now puts more of it in Peak, where you have no bank. "
            + "Run at 11:00 AM so less of it lands there.")
    }

    @Test func whyLineWhenNowIsCheapest() throws {
        let covered = [Self.lane("Off-Peak", start: 50, later: 10, startNow: 10)]
        // 25 kWh banked and nothing projected in, so the 40 kWh run leaves it 15 owed.
        let partly = [Estimator.BalanceLane(periodKey: "Off-Peak", startKwh: 25,
                                            recommended: [.init(date: Self.now, kwh: 25),
                                                          .init(date: Self.horizonEnd, kwh: 0)],
                                            startNow: [.init(date: Self.now, kwh: 25),
                                                       .init(date: Self.horizonEnd, kwh: 0)],
                                            projectedKwh: 25, projectedAfterRecommendedKwh: -15,
                                            projectedAfterStartNowKwh: -15)]
        let owed = [Self.lane("Off-Peak", start: -2, later: -42, startNow: -42)]
        func why(_ lanes: [Estimator.BalanceLane]) throws -> String {
            // At 18:00 the car (40 kWh from the wall) runs during Off-Peak.
            let comparison = Estimator.Comparison(
                costNow: 1, recommendedStart: Self.at(18), recommendedEnd: Self.at(22.4), recommendedCost: 1,
                savings: 0,
                bestAlternativeSavings: 0, estimatedSolarContribution: 0, horizonStart: Self.at(18),
                horizonEnd: Self.horizonEnd,
                evaluatedStarts: [Self.at(18)], assumptions: [], hasUnobservedBalance: false, lanes: lanes,
                periodSwitches: [])
            let screen = SmartShiftPresentation.make(
                profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
                forecast: .none, refreshUnavailable: false,
                inputs: .init(timing: Self.timing(), now: Self.at(18), billingCycleEnd: Self.at(480),
                              currencyCode: "USD", timeZone: "UTC"))
            return try Self.verdict(screen).why
        }
        #expect(try why(covered) == "It's Off-Peak, and your Off-Peak bank covers all of this run.")
        #expect(try why(partly) == "It's Off-Peak, and your Off-Peak bank covers most of this run.")
        #expect(try why(owed) == "It's Off-Peak; this run is bought at the full rate.")
    }

    @Test func barSavingIsTheShortSavingClaim() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        #expect(verdict.barSaving == "\(Self.money(1.89)) cheaper")
    }

    @Test func barSavingIsAbsentWithoutASavingClaim() throws {
        let comparison = Self.comparison(recommendedStart: Self.now)
        let nowBest = try Self.verdict(Self.make(profile: Self.pump,
                                                 result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(nowBest.barSaving == nil)
        let (unsafe, now) = Self.unsafeNow()
        #expect(try Self.cycleVerdict(unsafe, now: now).barSaving == nil)
    }

    @Test func whyLineWhenNowRunsIntoAnotherPeriod() throws {
        // 14 kWh over 4.4 h from 05:00 runs from Off-Peak into Peak; the later start stays in Off-Peak.
        let start = Self.at(5)
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14,
                               durationHours: 4.4, carSettings: nil)
        let comparison = Estimator.Comparison(
            costNow: 4, recommendedStart: Self.at(16.5), recommendedEnd: Self.at(20.9), recommendedCost: 2, savings: 2,
            bestAlternativeSavings: 2, estimatedSolarContribution: 0, horizonStart: start, horizonEnd: Self.horizonEnd,
            evaluatedStarts: [start], assumptions: [], hasUnobservedBalance: false,
            lanes: [Self.lane("Off-Peak", start: 18, later: 4, startNow: 11.6),
                    Self.lane("Peak", start: -6, later: -6, startNow: -13.6)],
            periodSwitches: [Self.at(7)])
        let screen = SmartShiftPresentation.make(
            profile: pump, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .none, refreshUnavailable: false,
            inputs: .init(timing: Self.timing(), now: start, billingCycleEnd: Self.at(480),
                          currencyCode: "USD", timeZone: "UTC"))
        #expect(Self.normalized(try Self.verdict(screen).why)
            == "Starting now runs into Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 4:30 PM it uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }
}
