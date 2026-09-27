import Foundation
import Testing
@testable import PWUsage

@Suite("Load Timing Recommendation Tests")
struct LoadTimingRecommendationTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let freshnessWindow: TimeInterval = 60 * 60

    private func appliance(_ id: String, _ kwh: Double, hours: Double = 1) -> LoadProfile {
        LoadProfile(id: id, name: id, kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }

    private func car(_ id: String = "car", capacity: Double = 60, from: Double = 20, to: Double = 30, level: CarChargingLevel = .level2) -> LoadProfile {
        LoadProfile(id: id, name: id, kind: .car, energyKwh: 0, durationHours: 0,
            carSettings: CarLoadSettings(capacityKwh: capacity, initialStateOfCharge: from, targetStateOfCharge: to, chargingLevel: level))
    }

    private func segment(_ from: TimeInterval, _ to: TimeInterval, key: String = "p") -> LoadTimingTariffSegment {
        LoadTimingTariffSegment(start: start.addingTimeInterval(from), end: start.addingTimeInterval(to),
            periodKey: key, name: key, buyRate: 0.5, sellRate: 0.1)
    }

    private func period(_ name: String, _ balance: Double) -> LoadTimingPeriod {
        LoadTimingPeriod(name: name, marginalCost: 0.1, basis: "sell", cycleNetExportKwh: balance,
            isActive: true, nextStartPhrase: nil, buyRate: 0.5, sellRate: 0.1)
    }

    private func timing(_ segments: [LoadTimingTariffSegment], balances: [String: Double] = ["p": 100], hasCycleData: Bool = true, hasTariff: Bool = true) -> LoadTiming {
        let periods = balances.map { period($0.key, $0.value) }
        return LoadTiming(hasTariff: hasTariff, hasCycleData: hasCycleData, activeIsCheapest: true,
            periods: periods, pricingPeriods: periods, tariffTimeline: segments,
            nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
    }

    private func evaluate(_ profiles: [LoadProfile], _ timing: LoadTiming,
                          through: Date? = nil, refreshUnavailable: Bool = false,
                          cycleEnd: Date? = nil, start: Date? = nil) -> LoadTimingRecommendation {
        LoadTimingRecommendation.evaluate(profiles: profiles, start: start ?? self.start, timing: timing,
            energyDataThrough: through ?? self.start, cycleEnd: cycleEnd ?? self.start.addingTimeInterval(7 * 86400),
            refreshUnavailable: refreshUnavailable)
    }

    @Test("Small surplus recommends the small appliance and abundant surplus recommends configured car charge")
    func choosesByWallEnergyThatFits() throws {
        let profiles = [appliance("washer", 4), car()]
        let limited = evaluate(profiles, timing([segment(0, 7200)], balances: ["p": 5]))
        #expect(limited.state == .ready)
        #expect(try #require(limited.suggested).profile.id == "washer")

        let abundant = evaluate(profiles, timing([segment(0, 7200)], balances: ["p": 100]))
        #expect(try #require(abundant.suggested).profile.id == "car")
    }

    @Test("Selects greatest eligible wall load with stable ties in saved profile order")
    func selectsLargestAndStableTie() throws {
        let small = appliance("small", 3)
        let large = appliance("large", 8)
        let recommendation = evaluate([small, large], timing([segment(0, 3600)], balances: ["p": 10]))
        #expect(try #require(recommendation.suggested).profile.id == "large")
        let tieA = appliance("tie-a", 6)
        let tieB = appliance("tie-b", 6)
        #expect(try #require(evaluate([tieA, tieB], timing([segment(0, 3600)], balances: ["p": 10])).suggested).profile.id == "tie-a")
        #expect(try #require(evaluate([tieB, tieA], timing([segment(0, 3600)], balances: ["p": 10])).suggested).profile.id == "tie-b")
    }

    @Test("Car eligibility uses wall energy including charging losses")
    func carUsesWallEnergy() throws {
        let profile = car(capacity: 60, from: 0, to: 10, level: .level2)
        let estimate = LoadTimingEstimator.carChargeEstimate(settings: try #require(profile.carSettings))
        let balance = try #require(estimate).batteryKwh
        let recommendation = evaluate([profile, appliance("small", balance)], timing([segment(0, 3600)], balances: ["p": balance]))
        #expect(recommendation.suggested?.profile.id == "small")
        #expect(try #require(recommendation.candidates.first).fitsSurplus == false)
    }

    @Test("Full run must have observed surplus in each tariff period it uses")
    func fullRunCrossesTariffPeriods() throws {
        let profiles = [appliance("crossing", 4, hours: 2), appliance("small", 2)]
        let timeline = [segment(0, 3600, key: "a"), segment(3600, 7200, key: "b")]
        let enough = evaluate(profiles, timing(timeline, balances: ["a": 2, "b": 2]))
        #expect(try #require(enough.suggested).profile.id == "crossing")
        let laterShort = evaluate(profiles, timing(timeline, balances: ["a": 2, "b": 1]))
        #expect(try #require(laterShort.suggested).profile.id == "small")
        let unknownLater = evaluate(profiles, timing(timeline, balances: ["a": 2]))
        #expect(try #require(unknownLater.suggested).profile.id == "small")
        #expect(unknownLater.state == .ready)
    }

    @Test("Repeated tariff periods share one balance and alternatives keep independent balances")
    func repeatedPeriodsAndIndependentCandidates() throws {
        let repeated = [segment(0, 3600, key: "a"), segment(3600, 7200, key: "b"), segment(7200, 10800, key: "a")]
        let profiles = [appliance("six", 6, hours: 3), appliance("four", 4, hours: 2)]
        let recommendation = evaluate(profiles, timing(repeated, balances: ["a": 2, "b": 2]))
        #expect(try #require(recommendation.suggested).profile.id == "four")
        #expect(try #require(recommendation.candidates[0].estimate).segments.filter { $0.periodKey == "a" }.reduce(0) { $0 + $1.surplusKwh } == 2)
        #expect(recommendation.candidates[1].surplusKwh == 4)
    }

    @Test("Exact surplus coverage is eligible and only one micro-kilowatt-hour of tolerance is allowed")
    func exactCoverageAndTolerance() throws {
        let profile = appliance("load", 4)
        #expect(evaluate([profile], timing([segment(0, 3600)], balances: ["p": 4])).state == .ready)
        #expect(evaluate([profile], timing([segment(0, 3600)], balances: ["p": 4 - 0.0000005])).state == .ready)
        #expect(evaluate([profile], timing([segment(0, 3600)], balances: ["p": 4 - 0.000002])).state == .noFit)
    }

    @Test("Deficits and absent cycle observations are not recommendation surplus")
    func deficitAndMissingObservations() {
        let profile = appliance("load", 4)
        let deficit = evaluate([profile], timing([segment(0, 3600)], balances: ["p": -4]))
        #expect(deficit.suggested == nil)
        #expect(deficit.state == .noFit)
        let absent = evaluate([profile], timing([segment(0, 3600)], balances: [:], hasCycleData: false))
        #expect(absent.suggested == nil)
        #expect(absent.state == .incompleteData)
    }

    @Test("Missing timeline coverage is incomplete data while retaining smaller safe recommendations")
    func missingTimelineCoverage() throws {
        let profiles = [appliance("long", 4, hours: 2), appliance("short", 1)]
        let result = evaluate(profiles, timing([segment(0, 3600)], balances: ["p": 10]))
        #expect(try #require(result.suggested).profile.id == "short")
        #expect(result.candidates[0].result == .unavailable(.incompleteTimeline))
        #expect(result.state == .ready)
        let noTimeline = evaluate([appliance("load", 2)], timing([], balances: ["p": 10]))
        #expect(noTimeline.state == .incompleteData)
        #expect(noTimeline.candidates[0].result == .unavailable(.incompleteTimeline))
    }

    @Test("A timeline without a configured tariff cannot produce a recommendation")
    func missingTariffConfigurationSuppressesRecommendation() {
        let profile = appliance("load", 2)
        let noTariff = timing([segment(0, 3600)], balances: ["p": 10], hasTariff: false)
        let result = evaluate([profile], noTariff)
        #expect(result.suggested == nil)
        #expect(result.state == .incompleteData)
        #expect(result.candidates[0].result == .unavailable(.incompleteTimeline))
        #expect(!result.candidates[0].fitsSurplus)
    }

    @Test("Stale missing future source times and refresh failures suppress positive advice")
    func staleInputsSuppressSuggestion() {
        let profile = appliance("load", 2)
        let freshTiming = timing([segment(0, 3600)], balances: ["p": 10])
        let stale = evaluate([profile], freshTiming, through: start.addingTimeInterval(-freshnessWindow - 1))
        #expect(stale.state == .stale)
        #expect(stale.suggested == nil)
        #expect(stale.candidates[0].fitsSurplus)
        #expect(evaluate([profile], freshTiming, through: start.addingTimeInterval(-freshnessWindow)).state == .ready)
        let missing = LoadTimingRecommendation.evaluate(profiles: [profile], start: start, timing: freshTiming,
            energyDataThrough: nil, cycleEnd: start.addingTimeInterval(86400), refreshUnavailable: false)
        #expect(missing.state == .stale)
        #expect(evaluate([profile], freshTiming, through: start.addingTimeInterval(1)).state == .stale)
        #expect(evaluate([profile], freshTiming, refreshUnavailable: true).state == .stale)
    }

    @Test("Stale, missing, or future observations cannot prove that surplus will not cover a load")
    func noFitRequiresFreshObservations() {
        let profile = appliance("load", 4)
        let insufficient = timing([segment(0, 3600)], balances: ["p": 1])
        let stale = evaluate([profile], insufficient, through: start.addingTimeInterval(-freshnessWindow - 1))
        #expect(stale.suggested == nil)
        #expect(stale.state == .stale)

        let missing = LoadTimingRecommendation.evaluate(profiles: [profile], start: start, timing: insufficient,
            energyDataThrough: nil, cycleEnd: start.addingTimeInterval(86400), refreshUnavailable: false)
        #expect(missing.suggested == nil)
        #expect(missing.state == .stale)

        let future = evaluate([profile], insufficient, through: start.addingTimeInterval(1))
        #expect(future.suggested == nil)
        #expect(future.state == .stale)
    }

    @Test("Run beginning after billing-cycle expiry is explicitly unavailable")
    func expiredCycleUnavailable() throws {
        let end = start.addingTimeInterval(-1)
        let result = evaluate([appliance("load", 2)], timing([segment(0, 3600)], balances: ["p": 10]), cycleEnd: end)
        #expect(result.suggested == nil)
        #expect(result.candidates[0].result == .unavailable(.billingCycleExpired))
        #expect(result.state == .incompleteData)
    }

    @Test("Run ending after billing-cycle boundary cannot use current-cycle credits")
    func runCrossesCycleEnd() throws {
        let end = start.addingTimeInterval(1800)
        let profile = appliance("load", 2, hours: 1)
        let result = evaluate([profile], timing([segment(0, 3600)], balances: ["p": 10]), cycleEnd: end)
        #expect(result.candidates[0].result == .unavailable(.billingCycleExpired))
        #expect(result.suggested == nil)
    }

    @Test("Zero-charge car remains explorable and all no-energy profiles need no energy")
    func noEnergyStates() throws {
        let zeroCar = car(from: 80, to: 80)
        let one = evaluate([zeroCar, appliance("positive", 2)], timing([segment(0, 3600)], balances: ["p": 10]))
        #expect(one.candidates[0].result == .noCharge)
        #expect(try #require(one.exploredProfile(explicitID: zeroCar.id)).result == .noCharge)
        let allNoEnergy = evaluate([zeroCar], timing([]))
        #expect(allNoEnergy.state == .noEnergyNeeded)
    }

    @Test("Empty profile collection has a distinct state")
    func emptyCandidates() {
        #expect(evaluate([], timing([])).state == .noCandidates)
    }

    @Test("Exploration prefers explicit valid choice and otherwise follows suggestion then saved order")
    func explorationSelection() throws {
        let first = appliance("first", 2)
        let second = appliance("second", 4)
        let result = evaluate([first, second], timing([segment(0, 3600)], balances: ["p": 10]))
        #expect(try #require(result.exploredProfile(explicitID: first.id)).profile.id == "first")
        #expect(try #require(result.exploredProfile(explicitID: nil)).profile.id == "second")
        #expect(try #require(result.exploredProfile(explicitID: "deleted")).profile.id == "second")
        let noFit = evaluate([first, second], timing([segment(0, 3600)], balances: ["p": 1]))
        #expect(try #require(noFit.exploredProfile(explicitID: nil)).profile.id == "first")
    }

    @Test("An explicit explored profile survives recommendation changes and falls back after deletion")
    func explicitExplorationSurvivesReevaluation() throws {
        let first = appliance("first", 2)
        let second = appliance("second", 4)
        let abundant = evaluate([first, second], timing([segment(0, 3600)], balances: ["p": 10]))
        #expect(try #require(abundant.exploredProfile(explicitID: first.id)).profile.id == "first")
        let changed = evaluate([first, second], timing([segment(0, 3600)], balances: ["p": 2]))
        #expect(try #require(changed.exploredProfile(explicitID: first.id)).profile.id == "first")
        #expect(try #require(changed.exploredProfile(explicitID: "second")).profile.id == "second")
        #expect(try #require(changed.exploredProfile(explicitID: "deleted")).profile.id == "first")
    }

    @Test("Remaining surplus includes only touched period keys and is unknown when a touched balance is absent")
    func remainingRelevantSurplus() throws {
        let timeline = [segment(0, 3600, key: "a"), segment(3600, 7200, key: "b")]
        let known = evaluate([appliance("load", 4, hours: 2)], timing(timeline, balances: ["a": 3, "b": 3, "unused": 99]))
        #expect(try #require(known.candidates[0].remainingSurplusKwh) == 2)
        let unknown = evaluate([appliance("load", 4, hours: 2)], timing(timeline, balances: ["a": 3]))
        #expect(unknown.candidates[0].remainingSurplusKwh == nil)
    }
}
