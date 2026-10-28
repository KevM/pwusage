import Foundation
@testable import PWUsage
import Testing

@Suite
struct SmartShiftPropertyTests {
    @Test(arguments: Array(UInt64(0) ..< 500))
    func generatedScenario(seed: UInt64) throws {
        try verifySmartShift(SmartShiftScenario(seed: seed))
    }

    @Test(arguments: Array(UInt64(0) ..< 24))
    func tariffOrderingDoesNotChangeResults(seed: UInt64) throws {
        let scenario = SmartShiftScenario(seed: seed)
        let original = try #require(scenario.evaluate().comparison)
        let reversed = try #require(scenario.evaluate(reversed: true).comparison)
        #expect(original == reversed, "\(scenario.diagnostic)")
    }

    @Test(arguments: [0, 1, 2, 3], [Double(-1), 0, 1])
    func freshnessBoundary(mode: Int, offset: Double) throws {
        var scenario = SmartShiftScenario(seed: UInt64(mode))
        scenario.age = (mode == 3 ? 1800 : 3600) + offset
        let result = scenario.evaluate()
        if offset > 0 {
            #expect(result.unavailableReason == .staleBalance, "\(scenario.diagnostic)")
        } else {
            _ = try #require(result.comparison, "\(scenario.diagnostic)")
        }
    }

    @Test(arguments: [0, 1, 2, 3])
    func rateChangeTruncatesProjection(mode: Int) throws {
        var scenario = SmartShiftScenario(seed: UInt64(mode))
        scenario.billHours = 72
        scenario.forecastHours = 48
        scenario.duration = 1
        let boundary = scenario.now.addingTimeInterval(12 * 3600)
        let segments = scenario.tariffs.map { segment in
            LoadTimingTariffSegment(start: segment.start, end: segment.end, periodKey: segment.periodKey,
                                    name: segment.name, buyRate: segment.buyRate + (segment.start >= boundary ? 1 : 0), sellRate: segment.sellRate)
        }
        let comparison = try #require(scenario.evaluate(segments: segments).comparison)
        #expect(comparison.projectionEnd == boundary)
        #expect(comparison.projectionEndsAtRateChange)
    }

    @Test(arguments: [1, 2, 3])
    func missingCurrentContextIsUnavailable(mode: Int) {
        let scenario = SmartShiftScenario(seed: UInt64(mode))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: scenario.zone)!
        let minute = calendar.component(.hour, from: scenario.now) * 60 + calendar.component(.minute, from: scenario.now) / 30 * 30
        let slots = scenario.projection.context!.slots.filter { $0.localMinute != minute }
        let context = LoadTimingForecastEstimator.PlanningContext(timeZone: scenario.zone, slots: slots, asOf: scenario.now)
        let projection: LoadTimingForecastEstimator.Projection = mode == 1 ? .history(context: context) : .forecast(intervals: scenario.forecast, context: context)
        #expect(scenario.evaluate(projection: projection).comparison == nil)
    }

    @Test func forecastGapFallsBackToHistory() throws {
        var scenario = SmartShiftScenario(seed: 2)
        scenario.billHours = 72
        scenario.forecastHours = 1
        scenario.duration = 0.5
        let later = SolarForecastInterval(periodStart: scenario.now.addingTimeInterval(7200),
                                          periodEnd: scenario.now.addingTimeInterval(10800), powerKw: 100)
        let projection = LoadTimingForecastEstimator.Projection.forecast(intervals: scenario.forecast + [later], context: scenario.projection.context!)
        let expected = try #require(scenario.evaluate().comparison)
        let actual = try #require(scenario.evaluate(projection: projection).comparison)
        #expect(actual == expected)
    }

    @Test func corpusExercisesAllProjectionAndSafetyBranches() throws {
        var modes: Set<Int> = []
        var safetyKinds: Set<String> = []
        for seed in UInt64(0) ..< 500 {
            let scenario = SmartShiftScenario(seed: seed)
            modes.insert(scenario.mode)
            let comparison = try #require(scenario.evaluate().comparison, "\(scenario.diagnostic)")
            switch comparison.safety {
            case .nowSafe: safetyKinds.insert("safe")
            case .nowUnsafe: safetyKinds.insert("wait")
            case .noSafeStart: safetyKinds.insert("shortfall")
            }
        }
        #expect(modes == [0, 1, 2, 3])
        #expect(safetyKinds == ["safe", "wait", "shortfall"])
    }

    @Test func serializedScenarioReplaysIdentically() throws {
        let scenario = SmartShiftScenario(seed: 42)
        let decoded = try JSONDecoder().decode(SmartShiftScenario.self, from: Data(scenario.diagnostic.utf8))
        #expect(decoded.diagnostic == scenario.diagnostic)
        #expect(decoded.evaluate() == scenario.evaluate())
    }

    @Test func referenceCalculatorHasHandCalculatedAnchors() {
        var scenario = SmartShiftScenario(seed: 0)
        scenario.mode = 0
        scenario.duration = 1
        scenario.energy = 3
        scenario.billHours = 24
        scenario.balances = [0, 2] // p1 is active at now: 2 exported kWh displaced, 1 imported.
        scenario.buys = [0.30, 0.30]
        scenario.sells = [0.05, 0.05]
        #expect(abs(SmartShiftReference(scenario: scenario).cost(start: scenario.now) - 0.40) < 1e-9)
        scenario.mode = 1
        scenario.age = 300 // last observed interval ends exactly at now.
        scenario.grid = 1
        scenario.dullGrid = 1
        let base = SmartShiftReference(scenario: scenario).baseline(until: scenario.expectedEnd)
        #expect(abs(base[0] - 12) < 1e-9)
        #expect(abs(base[1] - 14) < 1e-9)
    }
}

struct SmartShiftRegressionTests {
    @Test func zeroProjectedBankDoesNotTriggerCloudyWeekRule() throws {
        // Discovered by stress seed 4610: the active bank has 3 kWh, then
        // exports nothing for 12 hours and imports 0.1 kW for 30 bank-hours.
        // It reaches exactly zero; any positive remainder is rounding noise.
        // Pin the full fixture so generator evolution cannot change this regression.
        let fixture = #"""
        {"version":1,"seed":4610,"mode":2,"now":794642400,"age":0,"billHours":72,
         "zone":"Australia/Lord_Howe","energy":8,"duration":0.5,"balances":[1,3],
         "buys":[0.1,0.3],"sells":[0.04,0],"grid":-0.1,"dullGrid":-3.1,"home":0,
         "battery":0,"solar":0,"dullSolar":0,"forecastHours":12}
        """#
        let scenario = try JSONDecoder().decode(SmartShiftScenario.self, from: Data(fixture.utf8))
        let reference = SmartShiftReference(scenario: scenario)
        #expect(abs(reference.baseline(until: scenario.expectedEnd)[1]) < 1e-12)
        let comparison = try #require(scenario.evaluate().comparison)
        let bank = try #require(comparison.lanes.first { $0.periodKey == "p1" })
        #expect(comparison.safety == .nowSafe, "Projected bank: \(bank.projectedKwh) kWh")
    }
}

@Suite(.enabled(if: ProcessInfo.processInfo.environment["PWUSAGE_FUZZ_STRESS"] == "1"))
struct SmartShiftStressTests {
    @Test(arguments: Array(UInt64(500) ..< 10_500))
    func generatedScenario(seed: UInt64) throws {
        try verifySmartShift(SmartShiftScenario(seed: seed))
    }
}

/// Replay a single seed without editing the corpus. The scheme forwards this value.
@Suite(.enabled(if: UInt64(ProcessInfo.processInfo.environment["PWUSAGE_FUZZ_SEED"] ?? "") != nil))
struct SmartShiftReplayTests {
    @Test func replay() throws {
        let seed = try #require(UInt64(ProcessInfo.processInfo.environment["PWUSAGE_FUZZ_SEED"] ?? ""))
        try verifySmartShift(SmartShiftScenario(seed: seed))
    }
}

private func verifySmartShift(_ scenario: SmartShiftScenario, sourceLocation: SourceLocation = #_sourceLocation) throws {
    let s = scenario
    let comparison = try #require(s.evaluate().comparison, "Valid scenario must produce a comparison: \(s.diagnostic)", sourceLocation: sourceLocation)
    let oracle = SmartShiftReference(scenario: s)
    let message = Comment(rawValue: s.diagnostic)
    #expect(comparison.projectionEnd == s.expectedEnd, message, sourceLocation: sourceLocation)
    #expect(comparison.horizonEnd == min(s.tomorrowEnd, s.expectedEnd), message, sourceLocation: sourceLocation)
    #expect(comparison.safetyEnd == min(s.expectedEnd, s.now.addingTimeInterval(7 * 86400)), message, sourceLocation: sourceLocation)
    #expect(comparison.recommendedStart >= s.now, message, sourceLocation: sourceLocation)
    #expect(comparison.recommendedStart < comparison.horizonEnd, message, sourceLocation: sourceLocation)
    #expect(comparison.recommendedEnd <= s.expectedEnd, message, sourceLocation: sourceLocation)
    #expect(abs(comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart) - s.duration * 3600) < 1e-7, message, sourceLocation: sourceLocation)
    #expect(comparison.costNow.isFinite && comparison.recommendedCost.isFinite, message, sourceLocation: sourceLocation)
    #expect(abs(comparison.costNow - oracle.cost(start: s.now)) < 1e-7, message, sourceLocation: sourceLocation)
    #expect(abs(comparison.recommendedCost - oracle.cost(start: comparison.recommendedStart)) < 1e-7, message, sourceLocation: sourceLocation)
    #expect(abs(oracle.draws(start: comparison.recommendedStart, until: s.expectedEnd).reduce(0, +) - s.energy) < 1e-7, message, sourceLocation: sourceLocation)
    #expect(comparison.estimatedSolarContribution >= 0 && comparison.estimatedSolarContribution <= s.energy, message, sourceLocation: sourceLocation)

    // Deliberately check ranking over the advertised candidate set. This is not a
    // proof of global optimality between candidates; explicit boundary tests cover enumeration.
    let starts = comparison.evaluatedStarts
    #expect(starts.contains(s.now) && starts.contains(comparison.recommendedStart), message, sourceLocation: sourceLocation)
    #expect(starts.allSatisfy { $0 >= s.now && $0 < comparison.horizonEnd && $0.addingTimeInterval(s.duration * 3600) <= s.expectedEnd }, message, sourceLocation: sourceLocation)
    let assessed = starts.map { (start: $0, cost: oracle.cost(start: $0), shortfall: oracle.shortfall(start: $0)) }
    let passing = assessed.filter { $0.shortfall <= 3 + 1e-9 }
    let nowShortfall = oracle.shortfall(start: s.now)
    let selectedShortfall = oracle.shortfall(start: comparison.recommendedStart)
    if passing.isEmpty {
        let least = try #require(assessed.map(\.shortfall).min(), sourceLocation: sourceLocation)
        #expect(selectedShortfall <= least + 1e-7, message, sourceLocation: sourceLocation)
        if case .noSafeStart = comparison.safety {} else {
            Issue.record("Expected noSafeStart: \(s.diagnostic)", sourceLocation: sourceLocation)
        }
        let cheapest = try #require(assessed.filter { $0.shortfall <= least + 1e-9 }.map(\.cost).min(), sourceLocation: sourceLocation)
        #expect(comparison.recommendedCost <= cheapest + 0.01 + 1e-7, message, sourceLocation: sourceLocation)
    } else {
        #expect(selectedShortfall <= 3 + 1e-7, message, sourceLocation: sourceLocation)
        let cheapest = try #require(passing.map(\.cost).min(), sourceLocation: sourceLocation)
        let allowance = nowShortfall <= 3 + 1e-9 ? 0.01 : 0
        #expect(comparison.recommendedCost <= cheapest + allowance + 1e-7, message, sourceLocation: sourceLocation)
        if nowShortfall <= 3 + 1e-9 {
            #expect(comparison.safety == .nowSafe, message, sourceLocation: sourceLocation)
            if oracle.cost(start: s.now) - cheapest < 0.01 - 1e-7 {
                #expect(comparison.recommendedStart == s.now, message, sourceLocation: sourceLocation)
            }
        } else if case .nowUnsafe = comparison.safety {} else {
            Issue.record("Expected nowUnsafe: \(s.diagnostic)", sourceLocation: sourceLocation)
        }
    }
    let baseline = oracle.baseline(until: s.expectedEnd)
    let recommendedDraw = oracle.draws(start: comparison.recommendedStart, until: s.expectedEnd)
    for lane in comparison.lanes {
        let bank = lane.periodKey == "p0" ? 0 : 1
        #expect(abs(lane.projectedKwh - baseline[bank]) < 1e-7, message, sourceLocation: sourceLocation)
        #expect(abs(lane.projectedAfterRecommendedKwh - (baseline[bank] - recommendedDraw[bank])) < 1e-7, message, sourceLocation: sourceLocation)
    }
}
