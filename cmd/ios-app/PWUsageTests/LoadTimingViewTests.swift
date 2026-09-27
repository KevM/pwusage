import Foundation
import Testing
@testable import PWUsage

@Suite("Load Timing Presentation Tests")
struct LoadTimingViewTests {
    @Test("Dashboard summary keeps its active rate and measured balance")
    func dashboardSummaryRetainsObservedDetails() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Off peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.12, basis: "sell", balanceKwh: 10, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(summary.title == "Off peak")
        #expect(summary.rate == "12¢/kWh")
        #expect(summary.balance == "Surplus 10.0 kWh")
    }

    @Test("Unobserved active period shows its configured buy rate and no balance")
    func dashboardSummaryRetainsUnobservedState() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: nil, basis: "unobserved", balanceKwh: nil, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(summary.rate == "48¢/kWh")
        #expect(summary.balance == "No balance yet")
    }

    @Test("Live tariff summary preserves missing tariff and stale source cues")
    func dashboardSummaryRetainsUnavailableAndStaleStates() {
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: false, isStale: false).message == "No active tariff is configured")
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: true, isStale: false).message == "Load timing is unavailable")
        let stale = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.48, basis: "buy", balanceKwh: -4, energyDataThrough: nil),
            hasTariff: true,
            isStale: true,
            currencyCode: "USD"
        )
        #expect(stale.freshness == "Showing the last successful live summary")
        #expect(stale.balance == "Deficit 4.0 kWh")
    }

    @Test("Live rate stays hidden until bill currency is known")
    func liveSummaryWaitsForCurrency() {
        let timing = ActiveLoadTiming(periodName: "Peak", buyRate: 0.485, sellRate: 0.12, marginalCost: 0.485, basis: "buy", balanceKwh: 2, energyDataThrough: nil)
        let unlocalized = DashboardPresentation.loadTimingSummary(timing, hasTariff: true, isStale: false)
        #expect(unlocalized.rate == nil)
        #expect(!unlocalized.accessibilityLabel.contains("cents per kilowatt-hour"))
        let localized = DashboardPresentation.loadTimingSummary(timing, hasTariff: true, isStale: false, currencyCode: "USD")
        #expect(localized.rate == "48.5¢/kWh")
        #expect(localized.accessibilityLabel.contains("48.5 cents per kilowatt-hour"))
    }

    @Test("Profile chip title honors edited profile values")
    func profileChipUsesEditedProfile() {
        let edited = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5, durationHours: 2.25, carSettings: nil)
        #expect(LoadTimingPresentation.profileChipTitle(edited) == "Washer · 3.5 kWh")
        #expect(LoadTimingPresentation.actionTitle(for: edited) == "Run Washer")

        let editedCar = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 999, durationHours: 999, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 50, chargingLevel: .level1))
        #expect(LoadTimingPresentation.profileChipTitle(editedCar) == "Car · 32 kWh battery")
        #expect(LoadTimingPresentation.profileChipAccessibilityLabel(editedCar).contains("37.6 kilowatt-hours from the wall"))
    }

    @Test("Active observed balance and source time have explicit labels")
    func currentBalanceAndSourceTimeAreExplained() {
        let active = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: 4.2, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [active], pricingPeriods: [active], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        #expect(LoadTimingPresentation.activeBalanceSummary(timing) == "Current Peak billing-cycle balance: 4.2 kWh surplus.")

        let sourceTime = Date(timeIntervalSince1970: 1_800_000_000)
        let summary = LoadTimingPresentation.sourceTimeSummary(sourceTime, timeZone: "UTC")
        #expect(summary.hasPrefix("Energy observations through "))
        #expect(summary.contains("8:00"))
    }

    @Test("Tariff breakdown uses start-now segment values without cost-coverage verdicts")
    func tariffBreakdownUsesSegmentEstimates() {
        let segments = [
            LoadTimingEstimator.StartNowSegment(periodKey: "peak", start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 1800), wallKwh: 4, surplusKwh: 0, boughtKwh: 4, total: 1.92),
            LoadTimingEstimator.StartNowSegment(periodKey: "off-peak", start: Date(timeIntervalSince1970: 1800), end: Date(timeIntervalSince1970: 3600), wallKwh: 4, surplusKwh: 2, boughtKwh: 2, total: 0.48),
        ]
        let rows = LoadTimingPresentation.breakdownRows(segments, currencyCode: "USD")
        #expect(rows.map(\.periodKey) == ["peak", "off-peak"])
        #expect(rows.map(\.wallEnergy) == ["4.0 kWh", "4.0 kWh"])
        #expect(rows.map(\.total) == ["$1.92", "$0.48"])
        #expect(rows[1].balance == "2.0 kWh observed surplus · 2.0 kWh at buy rate")
    }

    @Test("Observed positive surplus prices at sell rate and a deficit prices at buy rate")
    func observedBalanceSignFeedsStartNowCost() {
        let start = Date(timeIntervalSince1970: 1000)
        let period = LoadTimingPeriod(name: "Peak", marginalCost: 0.5, basis: "buy", cycleNetExportKwh: 10, isActive: true, nextStartPhrase: nil, buyRate: 0.5, sellRate: 0.1)
        let timeline = [LoadTimingTariffSegment(start: start, end: start.addingTimeInterval(7200), periodKey: "Peak", name: "Peak", buyRate: 0.5, sellRate: 0.1)]
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [period], pricingPeriods: [period], tariffTimeline: timeline, nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let profile = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 8, durationHours: 2, carSettings: nil)

        let deficitPeriod = LoadTimingPeriod(name: "Peak", marginalCost: 0.5, basis: "buy", cycleNetExportKwh: -10, isActive: true, nextStartPhrase: nil, buyRate: 0.5, sellRate: 0.1)
        let deficitTiming = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [deficitPeriod], pricingPeriods: [deficitPeriod], tariffTimeline: timeline, nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        #expect(LoadTimingPresentation.observedBalances(timing)["Peak"] == 10)
        #expect(LoadTimingPresentation.observedBalances(deficitTiming)["Peak"] == -10)
        let surplus = LoadTimingAffordance.evaluate(profile: profile, start: start, timing: timing, observedBalances: LoadTimingPresentation.observedBalances(timing))
        let deficit = LoadTimingAffordance.evaluate(profile: profile, start: start, timing: deficitTiming, observedBalances: LoadTimingPresentation.observedBalances(deficitTiming))
        guard case .estimate(let surplusEstimate) = surplus.result,
              case .estimate(let deficitEstimate) = deficit.result else { Issue.record("Expected estimates"); return }
        #expect(surplusEstimate.total == 0.8)
        #expect(surplusEstimate.segments[0].surplusKwh == 8)
        #expect(deficitEstimate.total == 4)
        #expect(deficitEstimate.segments[0].boughtKwh == 8)
    }

    @Test("Breakdown labels a period with no observed balance")
    func breakdownMarksUnobservedPeriod() {
        let segment = LoadTimingEstimator.StartNowSegment(periodKey: "overnight", start: .now, end: .now.addingTimeInterval(3600), wallKwh: 2, surplusKwh: 0, boughtKwh: 2, total: 0.96)
        let row = LoadTimingPresentation.breakdownRows([segment], currencyCode: "USD", unobservedPeriodKeys: ["overnight"]).first
        #expect(row?.balance == "No observed balance · estimated at buy rate")
    }

    @Test("Run card summary stays focused while details retain energy estimate")
    func runCardSummaryKeepsDecisionAtAGlance() {
        let estimate = LoadTimingEstimator.StartNowEstimate(
            total: 1.92,
            finishTime: Date(timeIntervalSince1970: 1_800_000_000),
            batteryKwh: 0,
            wallKwh: 4,
            durationHours: 2,
            segments: [],
            hasUnobservedBalance: true
        )
        let card = LoadTimingPresentation.runCardSummary(estimate, currencyCode: "USD", timeZone: "UTC")
        let details = LoadTimingPresentation.startNowSummary(estimate, currencyCode: "USD", timeZone: "UTC")

        #expect(card.total == "Estimated $1.92 to start now")
        #expect(card.finish == details.finish)
        #expect(details.energy == "About 4.0 kWh from the wall")
        #expect(LoadTimingPresentation.runDetailsAccessibilityLabel == "Load run details")
        #expect(LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: estimate.hasUnobservedBalance) != nil)
    }

    @Test("Run card outcomes preserve no-charge and unavailable messages")
    func runCardOutcomesRemainClear() {
        #expect(LoadTimingPresentation.noChargeMessage == "No charging needed at this target.")
        #expect(LoadTimingPresentation.unavailableMessage(.incompleteTimeline).contains("unavailable"))
    }

    @Test("Recommendation copy distinguishes ready, no fit, stale, incomplete, no energy, and empty profiles")
    func recommendationMessagesExplainEachState() {
        #expect(LoadTimingPresentation.recommendationMessage(for: .ready).title == "Good fit now")
        #expect(LoadTimingPresentation.recommendationMessage(for: .ready).detail == "Your observed tariff surplus covers this run’s estimated energy.")
        #expect(LoadTimingPresentation.recommendationMessage(for: .noFit).title == "Your surplus won’t cover a full load.")
        #expect(LoadTimingPresentation.recommendationMessage(for: .noFit, refreshUnavailable: true).detail.contains("refresh failed"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .stale).detail.contains("older than one hour"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .stale, refreshUnavailable: true).detail.contains("refresh failed"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .incompleteData, hasTariff: false).detail.contains("tariff"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .incompleteData, hasExpiredCandidate: true).detail.contains("billing cycle"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .noEnergyNeeded).detail.contains("already at its target"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .noCandidates).detail.contains("Add a load profile"))
    }

    @Test("Recommendation actions and neutral exploration titles name appliances and cars")
    func recommendationAndExplorationTitlesNameProfileKind() {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5, durationHours: 2, carSettings: nil)
        let car = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 50, chargingLevel: .level2))
        #expect(LoadTimingPresentation.actionTitle(for: washer) == "Run Washer")
        #expect(LoadTimingPresentation.actionTitle(for: car) == "Charge Car")
        #expect(LoadTimingPresentation.explorationTitle(for: washer) == "What if you run Washer?")
        #expect(LoadTimingPresentation.explorationTitle(for: car) == "What if you charge Car?")
    }

    @Test("Energy impact explains surplus used, buy-rate energy, and known or unknown remaining balance")
    func energyImpactShowsOnlyKnownRemainingSurplus() {
        let segment = LoadTimingEstimator.StartNowSegment(periodKey: "Peak", start: .now, end: .now.addingTimeInterval(3600), wallKwh: 5, surplusKwh: 1.5, boughtKwh: 3.5, total: 1.25)
        let estimate = LoadTimingEstimator.StartNowEstimate(total: 1.25, finishTime: .now, batteryKwh: 0, wallKwh: 5, durationHours: 1, segments: [segment], hasUnobservedBalance: false)
        let candidate = LoadTimingRecommendation.Candidate(profile: LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 5, durationHours: 1, carSettings: nil), result: .estimate(estimate), remainingSurplusKwh: 3.5)
        let impact = LoadTimingPresentation.energyImpact(candidate)
        #expect(impact.surplusConsumed == "Uses 1.5 kWh of observed surplus")
        #expect(impact.energyBought == "Buys 3.5 kWh at tariff rates")
        #expect(impact.remainingSurplus == "3.5 kWh surplus remains across the tariff periods used")
        let unknown = LoadTimingPresentation.energyImpact(LoadTimingRecommendation.Candidate(profile: candidate.profile, result: candidate.result, remainingSurplusKwh: nil))
        #expect(unknown.remainingSurplus == nil)
    }

    @Test("Alternative cost comparison explains more, less, and near-equal totals in response currency")
    func costDifferenceUsesCurrencyAndDirection() {
        #expect(LoadTimingPresentation.costDifference(alternativeCost: 3, suggestedCost: 2, currencyCode: "EUR") == "Estimated €1.00 more than the suggestion")
        #expect(LoadTimingPresentation.costDifference(alternativeCost: 1, suggestedCost: 2, currencyCode: "USD") == "Estimated $1.00 less than the suggestion")
        #expect(LoadTimingPresentation.costDifference(alternativeCost: 2.004, suggestedCost: 2, currencyCode: "USD") == "About the same estimated cost as the suggestion")
    }

    @Test("Explicit exploration stays selected across recommendation changes and deleted selections fall back safely")
    func explorationSelectionFollowsRecommendationOnlyWithoutExplicitSelection() throws {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)
        let car = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0, carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level2))
        let washerCandidate = LoadTimingRecommendation.Candidate(profile: washer, result: .unavailable(.incompleteTimeline), remainingSurplusKwh: nil)
        let carCandidate = LoadTimingRecommendation.Candidate(profile: car, result: .noCharge, remainingSurplusKwh: 0)
        let first = LoadTimingRecommendation(candidates: [washerCandidate, carCandidate], suggested: washerCandidate, state: .ready)
        let changed = LoadTimingRecommendation(candidates: [washerCandidate, carCandidate], suggested: carCandidate, state: .ready)
        #expect(first.exploredProfile(explicitID: nil)?.profile.id == "washer")
        #expect(changed.exploredProfile(explicitID: "washer")?.profile.id == "washer")
        #expect(changed.exploredProfile(explicitID: nil)?.profile.id == "car")
        #expect(changed.exploredProfile(explicitID: "deleted")?.profile.id == "car")
        #expect(LoadTimingPresentation.showsBackToSuggestion(explicitID: "washer", suggestedID: "car"))
        #expect(LoadTimingPresentation.showsBackToSuggestion(explicitID: "washer", suggestedID: nil) == false)
        #expect(LoadTimingPresentation.showsBackToSuggestion(explicitID: nil, suggestedID: "car") == false)
        #expect(LoadTimingPresentation.showsBackToSuggestion(explicitID: "car", suggestedID: "washer"))
        #expect(try #require(changed.exploredProfile(explicitID: "car")).result == .noCharge)
    }

    @Test("A failed refresh without saved response shows recommendation failure without inventing estimates")
    func missingResponseRecommendationExplainsRefreshFailure() {
        let message = LoadTimingPresentation.noResponseRecommendationMessage
        #expect(message.title == "Recommendation unavailable")
        #expect(message.detail.contains("refresh failed"))
        #expect(message.detail.contains("bill data"))
    }

    @Test("No-response explorer keeps a neutral selected-load title but withholds estimate and calculation")
    func missingResponseExplorerExplainsUnavailableEstimate() {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)
        #expect(LoadTimingPresentation.explorationTitle(for: washer) == "What if you run Washer?")
        #expect(LoadTimingPresentation.noResponseExplorationMessage.contains("bill response and tariff data"))
        #expect(LoadTimingPresentation.noResponseExplorationMessage.contains("estimate or calculation"))
    }

    @Test("Run details retain the profile, bill, estimate, currency, and captured time from presentation")
    func detailsSnapshotDoesNotFollowLaterInputs() throws {
        let firstTime = Date(timeIntervalSince1970: 1_800_000_000)
        let laterTime = firstTime.addingTimeInterval(3600)
        let firstProfile = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)
        let changedProfile = LoadProfile(id: "washer", name: "Washer XL", kind: .appliance, energyKwh: 8, durationHours: 2, carSettings: nil)
        let firstTiming = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [], pricingPeriods: [], tariffTimeline: [], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let changedTiming = LoadTiming(hasTariff: false, hasCycleData: false, activeIsCheapest: false, periods: [], pricingPeriods: [], tariffTimeline: [], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let firstResponse = try Self.billResponse(currency: "USD", estimatedCost: 75)
        let changedResponse = try Self.billResponse(currency: "EUR", estimatedCost: 125)
        let firstEstimate = LoadTimingEstimator.StartNowEstimate(total: 1.25, finishTime: firstTime.addingTimeInterval(3600), batteryKwh: 0, wallKwh: 3, durationHours: 1, segments: [], hasUnobservedBalance: false)
        let laterEstimate = LoadTimingEstimator.StartNowEstimate(total: 4, finishTime: laterTime.addingTimeInterval(7200), batteryKwh: 0, wallKwh: 8, durationHours: 2, segments: [], hasUnobservedBalance: false)

        var profile = firstProfile
        var timing = firstTiming
        var response = firstResponse
        var result: LoadTimingEstimator.StartNowResult = .estimate(firstEstimate)
        var currencyCode = "USD"
        var timeZone = "UTC"
        var capturedAt = firstTime
        let snapshot = LoadRunDetailsSnapshot(profile: profile, timing: timing, response: response, result: result, currencyCode: currencyCode, timeZone: timeZone, capturedAt: capturedAt)

        profile = changedProfile
        timing = changedTiming
        response = changedResponse
        result = .estimate(laterEstimate)
        currencyCode = "EUR"
        timeZone = "Europe/Paris"
        capturedAt = laterTime

        #expect(profile == changedProfile)
        #expect(timing == changedTiming)
        #expect(response.currentBill.currency == "EUR")
        #expect(response.currentBill.estimatedCost == 125)
        #expect(result == .estimate(laterEstimate))
        #expect(currencyCode == "EUR")
        #expect(timeZone == "Europe/Paris")
        #expect(capturedAt == laterTime)
        #expect(snapshot.profile == firstProfile)
        #expect(snapshot.timing == firstTiming)
        #expect(snapshot.response?.currentBill.currency == "USD")
        #expect(snapshot.response?.currentBill.estimatedCost == 75)
        #expect(snapshot.result == .estimate(firstEstimate))
        #expect(snapshot.currencyCode == "USD")
        #expect(snapshot.timeZone == "UTC")
        #expect(snapshot.capturedAt == firstTime)
    }

    private static func billResponse(currency: String, estimatedCost: Double) throws -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":\#(estimatedCost),"currency":"\#(currency)","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"loadTiming":null,"sources":{"calculatedAt":"2026-09-26T12:00:00Z","energyDataThrough":"2026-09-26T12:00:00Z"}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }
}
