import Foundation
import Testing
@testable import PWUsage

@Suite("Load Timing Estimator Tests")
struct LoadTimingEstimatorTests {
    private func segment(_ start: Date, _ end: Date, key: String = "p", buy: Double = 0.5, sell: Double = 0.1) -> LoadTimingTariffSegment {
        LoadTimingTariffSegment(start: start, end: end, periodKey: key, name: key, buyRate: buy, sellRate: sell)
    }

    private func appliance(_ kwh: Double = 4, hours: Double = 2) -> LoadProfile {
        LoadProfile(id: "test", name: "Test", kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }

    @Test("Start now prices exact overlaps and reports completion")
    func startNowCrossesTariffBoundary() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(3600), key: "a", buy: 0.4, sell: 0.1),
                             segment(start.addingTimeInterval(3600), start.addingTimeInterval(7200), key: "b", buy: 0.6, sell: 0.2)],
            observedBalances: [:])
        guard case let .estimate(value) = result else { Issue.record("Expected estimate"); return }
        #expect(value.finishTime == start.addingTimeInterval(7200))
        #expect(value.wallKwh == 4)
        #expect(value.total == 2)
        #expect(value.segments.count == 2)
        #expect(abs(value.segments.reduce(0) { $0 + $1.total } - value.total) < 0.000_001)
    }

    @Test("A load finishing exactly at the available timeline boundary needs no next segment")
    func exactFinishAtAvailableBoundary() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(2, hours: 1), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(3600))], observedBalances: [:])
        guard case let .estimate(value) = result else { Issue.record("Expected estimate"); return }
        #expect(value.finishTime == start.addingTimeInterval(3600))
        #expect(value.segments.count == 1)
        #expect(value.total == 1)
    }

    @Test("Surplus is allocated once per period key across repeated intervals")
    func surplusBankIsSharedByRepeatedPeriodKey() {
        let start = Date(timeIntervalSince1970: 0)
        let segments = [segment(start, start.addingTimeInterval(3600), key: "same"),
                        segment(start.addingTimeInterval(3600), start.addingTimeInterval(7200), key: "middle"),
                        segment(start.addingTimeInterval(7200), start.addingTimeInterval(10800), key: "same")]
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(6, hours: 3), start: start,
            tariffTimeline: segments, observedBalances: ["same": 1])
        guard case let .estimate(value) = result else { Issue.record("Expected estimate"); return }
        #expect(value.segments.reduce(0) { $0 + $1.surplusKwh } == 1)
        #expect(value.segments[2].surplusKwh == 0)
        #expect(value.segments[2].boughtKwh == 2)
        #expect(value.total == 2.6)
    }

    @Test("Accepts a zero sell rate while continuing to price bought energy")
    func zeroSellRateIsValid() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(2, hours: 1), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(3600), buy: 0.5, sell: 0)],
            observedBalances: ["p": 1])
        guard case let .estimate(value) = result else { Issue.record("Expected estimate"); return }
        #expect(value.total == 0.5)
        #expect(value.segments[0].surplusKwh == 1)
        #expect(value.segments[0].boughtKwh == 1)
    }

    @Test("Rejects a negative sell rate")
    func negativeSellRateIsInvalid() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(7200), sell: -0.1)], observedBalances: [:])
        #expect(result == .unavailable(.invalidInput))
    }

    @Test("Deficit balance buys all energy and missing balance is flagged")
    func deficitAndUnobservedBalance() {
        let start = Date(timeIntervalSince1970: 0)
        let timeline = [segment(start, start.addingTimeInterval(7200))]
        let deficit = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: timeline, observedBalances: ["p": -3])
        guard case let .estimate(a) = deficit else { Issue.record("Expected estimate"); return }
        #expect(a.total == 2)
        let missing = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: timeline, observedBalances: [:])
        guard case let .estimate(b) = missing else { Issue.record("Expected estimate"); return }
        #expect(b.hasUnobservedBalance)
        #expect(b.total == 2)
    }

    @Test("Requires complete contiguous tariff coverage")
    func incompleteTimelineUnavailable() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(3599)), segment(start.addingTimeInterval(3600), start.addingTimeInterval(7200))], observedBalances: [:])
        #expect(result == .unavailable(.incompleteTimeline))
    }

    @Test("Rejects overlapping tariff intervals within the requested horizon")
    func overlappingTimelineUnavailable() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(2, hours: 2), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(4500), key: "first"),
                             segment(start.addingTimeInterval(3600), start.addingTimeInterval(7200), key: "overlap")],
            observedBalances: [:])
        #expect(result == .unavailable(.incompleteTimeline))
    }

    @Test("Rejects a non-finite observed balance")
    func nonfiniteObservedBalanceIsInvalid() {
        let start = Date(timeIntervalSince1970: 0)
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start,
            tariffTimeline: [segment(start, start.addingTimeInterval(7200))], observedBalances: ["p": .nan])
        #expect(result == .unavailable(.invalidInput))
    }

    @Test("Rejects car state of charge outside zero through one hundred")
    func outOfRangeCarStateOfChargeIsInvalid() {
        let start = Date(timeIntervalSince1970: 0)
        let profile = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
            carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 101, targetStateOfCharge: 80, chargingLevel: .level2))
        let result = LoadTimingEstimator.estimateStartNow(profile: profile, start: start,
            tariffTimeline: [], observedBalances: [:])
        #expect(result == .unavailable(.invalidInput))
    }

    @Test("Zero car charge is distinct from unavailable")
    func zeroCarChargeState() {
        var profile = appliance()
        profile = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
            carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 80, targetStateOfCharge: 80, chargingLevel: .level1))
        let result = LoadTimingEstimator.estimateStartNow(profile: profile, start: Date(), tariffTimeline: [], observedBalances: [:])
        #expect(result == .noCharge)
    }

    @Test("Car charging level changes wall energy and duration while preserving battery energy")
    func carLevelAssumptionsApply() {
        let start = Date(timeIntervalSince1970: 0)
        let timeline = [segment(start, start.addingTimeInterval(86400))]
        let settings = CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level1)
        let l1 = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0, carSettings: settings)
        let l2 = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
            carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level2))
        guard case let .estimate(a) = LoadTimingEstimator.estimateStartNow(profile: l1, start: start, tariffTimeline: timeline, observedBalances: [:]),
              case let .estimate(b) = LoadTimingEstimator.estimateStartNow(profile: l2, start: start, tariffTimeline: timeline, observedBalances: [:]) else { Issue.record("Expected estimates"); return }
        #expect(a.batteryKwh == 6)
        #expect(a.wallKwh > b.wallKwh)
        #expect(a.durationHours > b.durationHours)
    }

    @Test("Rejects non-finite profile and tariff values")
    func rejectsNonfinite() {
        let start = Date(timeIntervalSince1970: 0)
        let timeline = [segment(start, start.addingTimeInterval(7200), buy: .infinity)]
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start, tariffTimeline: timeline, observedBalances: [:])
        #expect(result == .unavailable(.invalidInput))
    }

    @Test("A zero buy rate is a valid free-energy tariff")
    func zeroBuyRateIsPriced() {
        let start = Date(timeIntervalSince1970: 0)
        let timeline = [segment(start, start.addingTimeInterval(7200), buy: 0, sell: 0)]
        let result = LoadTimingEstimator.estimateStartNow(profile: appliance(), start: start, tariffTimeline: timeline, observedBalances: [:])
        guard case .estimate(let estimate) = result else { Issue.record("Expected a complete zero-cost estimate"); return }
        #expect(estimate.total == 0)
        #expect(estimate.wallKwh == 4)
    }

    @Test("Matches web covered, tight, partial, bought, and unknown verdicts")
    func verdictsMatchWeb() {
        #expect(LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 120, buyRate: 0.15, sellRate: 0.03), headroomKwh: 100).verdict == .covered)
        let tight = LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 70, buyRate: 0.48, sellRate: 0.12), headroomKwh: 100)
        #expect(tight.verdict == .tight)
        #expect(abs((tight.total ?? .nan) - 7.2) < 0.000_001)
        #expect(LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 10, buyRate: 0.48, sellRate: 0.12)).verdict == .partial)
        #expect(LoadTimingEstimator.costToRun(5, pricing: .init(surplusKwh: -20, buyRate: 0.48, sellRate: 0.12)).verdict == .bought)
        #expect(LoadTimingEstimator.costToRun(8, pricing: nil).verdict == .unknown)
        let unresolvedRates = LoadTimingEstimator.costToRun(8, pricing: .init(surplusKwh: 0, buyRate: 0, sellRate: 0))
        #expect(unresolvedRates.total == nil)
        #expect(unresolvedRates.verdict == .unknown)
    }

    @Test("Prices covered and bought energy at sell and buy rates")
    func pricesEnergyAtItsMarginalRate() {
        let result = LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 10, buyRate: 0.48, sellRate: 0.12))
        #expect(result.coveredKwh == 10)
        #expect(result.boughtKwh == 50)
        #expect(abs((result.total ?? .nan) - 25.2) < 0.000_001)
        let freeExport = LoadTimingEstimator.costToRun(5, pricing: .init(surplusKwh: 50, buyRate: 0.48, sellRate: 0))
        #expect(freeExport.total == 0)
        #expect(freeExport.verdict == .covered)
    }

    @Test("Provides web preset sizes and headroom thresholds")
    func profilesMatchWeb() {
        #expect(LoadTimingEstimator.profiles == [
            .init(id: "laundry", label: "Laundry", kwh: 8, headroomKwh: 20),
            .init(id: "dishwasher", label: "Dishwasher", kwh: 5, headroomKwh: 5),
        ])
        #expect(LoadTimingEstimator.customAmount(1) == 1)
        #expect(LoadTimingEstimator.customAmount(60) == 60)
        #expect(LoadTimingEstimator.customAmount(100) == 100)
        #expect(LoadTimingEstimator.customAmount(0) == 1)
        #expect(LoadTimingEstimator.customAmount(120) == 100)
    }

    @Test("Calculates energy needed to charge a car to its target")
    func carChargeEnergyUsesCapacityAndChargeDifference() {
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: 80) == 36)
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 80, targetPercent: 20) == 0)
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 80, targetPercent: 80) == 0)
    }

    @Test("Invalid car charge inputs never return negative or non-finite energy")
    func carChargeEnergyRejectsInvalidInputs() {
        for result in [
            LoadTimingEstimator.carChargeKwh(capacityKwh: .nan, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: .infinity, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: -60, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: .greatestFiniteMagnitude, currentPercent: 0, targetPercent: 100),
            LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: .infinity, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: .nan),
        ] {
            #expect(result.isFinite)
            #expect(result >= 0)
        }
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: -10, targetPercent: 110) == 60)
    }

    @Test("Car headroom stays proportional to the planned charge")
    func carHeadroomTracksPlannedCharge() {
        #expect(LoadTimingEstimator.carHeadroomKwh(plannedKwh: 36) == 57.6)
        #expect(LoadTimingEstimator.carHeadroomKwh(plannedKwh: 0) == 0)
        #expect(LoadTimingEstimator.carHeadroomKwh(plannedKwh: .nan) == 0)
    }

    @Test("Numeric inputs clamp to their range and replace non-finite values")
    func boundedNumericInputsStayValid() {
        #expect(LoadTimingEstimator.boundedInput(0, fallback: 60, range: 1...200) == 1)
        #expect(LoadTimingEstimator.boundedInput(250, fallback: 60, range: 1...200) == 200)
        #expect(LoadTimingEstimator.boundedInput(42, fallback: 60, range: 1...200) == 42)
        #expect(LoadTimingEstimator.boundedInput(.nan, fallback: 60, range: 1...200) == 60)
        #expect(LoadTimingEstimator.boundedInput(.infinity, fallback: 20, range: 0...100) == 20)
    }

    @Test("Zero or invalid car energy does not need a cost estimate")
    func chargeEstimateVisibilityRequiresPositiveFiniteEnergy() {
        #expect(LoadTimingEstimator.shouldEstimateCarCharge(36))
        #expect(!LoadTimingEstimator.shouldEstimateCarCharge(0))
        #expect(!LoadTimingEstimator.shouldEstimateCarCharge(-1))
        #expect(!LoadTimingEstimator.shouldEstimateCarCharge(.infinity))
    }
}
