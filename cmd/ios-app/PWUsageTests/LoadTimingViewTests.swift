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

/// Forecast-aware presentation is strictly additive: it contributes an enhanced
/// section and at most one small note. It can never replace or annotate the basic
/// estimator's own total, breakdown, or selected profile.
@Suite("Load Timing Forecast Presentation Tests")
struct LoadTimingForecastPresentationTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("A later start shows both costs, the saving, the window, solar, and the real horizon")
    func waitingRecommendationShowsFullComparison() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(-20 * 60),
            contextAsOf: Self.now.addingTimeInterval(-6 * 60 * 60),
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(overlay.enhanced)

        #expect(overlay.isForecastAware)
        #expect(enhanced.headline == "Waiting could save an estimated $1.20")
        #expect(enhanced.costNow == "Start now: $3.40")
        #expect(Self.normalized(enhanced.recommendedCost) == Self.normalized("Start at 10:00 AM: $2.20"))
        #expect(enhanced.savings == "Estimated savings $1.20")
        #expect(Self.normalized(enhanced.window) == Self.normalized("Runs 10:00 AM – 11:00 AM"))
        #expect(enhanced.solarContribution == "About 2.1 kWh of this run could come from your solar")
        #expect(Self.normalized(enhanced.horizon) == Self.normalized("Compared 8:00 AM – 6:00 PM"))
        #expect(enhanced.sourceAges.contains("Solar forecast · Updated 20 min ago"))
        #expect(enhanced.sourceAges.contains { $0.contains("Household pattern") })
    }

    @Test("Recommending now never promises a saving")
    func startNowRecommendationMakesNoSavingsPromise() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison(recommendedStart: Self.now, recommendedEnd: Self.now.addingTimeInterval(3600),
                                                   recommendedCost: 3.40, savings: 0, bestAlternativeSavings: 0)),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(overlay.enhanced)

        #expect(overlay.isForecastAware)
        #expect(enhanced.headline == "Start now — no cheaper start was found")
        #expect(enhanced.savings == nil)
        #expect(enhanced.costNow == "Start now: $3.40")
        #expect(Self.normalized(enhanced.recommendedCost) == Self.normalized("Start now: $3.40"))
    }

    @Test("A saving too small to act on is described as similarly priced, not as a saving")
    func insignificantSavingIsNotAdvertised() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison(recommendedStart: Self.now, recommendedEnd: Self.now.addingTimeInterval(3600),
                                                   recommendedCost: 3.36, savings: 0, bestAlternativeSavings: 0.04)),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(overlay.enhanced)

        #expect(enhanced.headline == "Start now — waiting would save about $0.04, which is not worth delaying")
        #expect(enhanced.savings == nil)
    }

    @Test("Enhanced detail states the behavioral assumption and that the final bill can differ")
    func enhancedDetailCarriesRequiredCaveats() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.detail.contains("typical household and battery behavior"))
        #expect(overlay.detail.lowercased().contains("final bill cost may differ"))
    }

    @Test("Enhanced copy never promises a battery refill or forecast confidence")
    func enhancedCopyMakesNoConfidencePromise() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let text = overlay.allText.joined(separator: " ").lowercased()

        for forbidden in ["guarantee", "refill", "recharge", "accurate", "confidence", "certain", "%"] {
            #expect(!text.contains(forbidden), "Enhanced copy must not contain \"\(forbidden)\"")
        }
    }

    @Test("An unrecognised Solar System ID points at array selection, not the network")
    func unknownResourceNoteNamesTheRemedy() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: .unknownResource,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.contains("does not recognise"))
        #expect(note.lowercased().contains("choose your arrays again"))
        #expect(note.lowercased().contains("counted as an attempt"))
        #expect(!note.lowercased().contains("could not be reached"))
    }

    @Test("Every non-enhanced state keeps the basic estimate and drops all forecast values")
    func everyFallbackStateStaysBasic() {
        // Distinctive values that must never appear beside a basic cost.
        let comparison = Self.waitingComparison()
        let unusable: [(String, SolarForecastEnhancementState, SolarForecastConnectionState, SolarForecastUnavailableCause?, LoadTimingForecastEstimator.Result)] = [
            ("no key", .basic, .notConnected, nil, Self.unavailable(.incompleteCoverage)),
            ("key removed", .disconnectedBasic, .notConnected, nil, Self.unavailable(.incompleteCoverage)),
            ("array selection incomplete", .basic, .awaitingArraySelection, nil, Self.unavailable(.incompleteCoverage)),
            ("first load pending", .loadingWithBasic, .ready, nil, Self.unavailable(.incompleteCoverage)),
            ("invalid key", .failedWithBasic, .ready, .unauthorized, Self.unavailable(.incompleteCoverage)),
            ("timeout", .failedWithBasic, .ready, .requestFailed, Self.unavailable(.incompleteCoverage)),
            ("quota exhausted", .failedWithBasic, .ready, .rateLimited, Self.unavailable(.incompleteCoverage)),
            ("partial array failure", .failedWithBasic, .ready, .invalidForecast, Self.unavailable(.incompleteCoverage)),
            ("stale forecast", .failedWithBasic, .ready, nil, Self.unavailable(.incompleteCoverage)),
            ("missing forecast", .failedWithBasic, .ready, nil, Self.unavailable(.incompleteCoverage)),
            ("context failure", .failedWithBasic, .ready, nil, Self.unavailable(.incompleteContext)),
            ("insufficient baseline", .failedWithBasic, .ready, nil, Self.unavailable(.incompleteBalance)),
            ("no full run in horizon", .enhanced, .ready, nil, Self.unavailable(.noFittingRun)),
            ("stale balance", .enhanced, .ready, nil, Self.unavailable(.staleBalance)),
            ("zero-charge car", .enhanced, .ready, nil, Self.unavailable(.noEnergyNeeded))
        ]

        for (label, enhancement, connection, cause, result) in unusable {
            let overlay = LoadTimingForecastPresentation.overlay(
                enhancement: enhancement,
                connection: connection,
                cause: cause,
                result: result,
                forecastFetchedAt: Self.now.addingTimeInterval(-20 * 60),
                contextAsOf: Self.now,
                currencyCode: "USD",
                timeZone: "UTC",
                now: Self.now
            )
            let text = overlay.allText.joined(separator: " ")

            #expect(!overlay.isForecastAware, "\(label) must not be forecast-aware")
            #expect(overlay.enhanced == nil, "\(label) must not carry an enhanced section")
            for value in ["$3.40", "$2.20", "$1.20", "2.1 kWh", "10:00 AM", "11:00 AM", "6:00 PM"] {
                #expect(!text.contains(value), "\(label) leaked forecast value \(value)")
            }
            #expect(!text.lowercased().contains("savings"), "\(label) must not promise savings")
            #expect(!text.lowercased().contains("could come from your solar"), "\(label) must not promise solar")
            #expect(comparison.savings == 1.20)
        }
    }

    @Test("A configured connection that fails shows one small note and never a blocking message")
    func configuredFailureShowsOneInformationalNote() {
        for cause in [SolarForecastUnavailableCause.unauthorized, .rateLimited, .requestFailed, .invalidForecast] {
            let overlay = LoadTimingForecastPresentation.overlay(
                enhancement: .failedWithBasic,
                connection: .ready,
                cause: cause,
                result: Self.unavailable(.incompleteCoverage),
                forecastFetchedAt: nil,
                contextAsOf: nil,
                currencyCode: "USD",
                timeZone: "UTC",
                now: Self.now
            )

            let note = overlay.note
            #expect(note?.contains("using tariff and balance data") == true)
            #expect(note?.contains("Retry") == true, "A failed connection must remain retryable, not terminal")
            #expect(overlay.enhanced == nil)
        }
    }

    @Test("Without a configured connection no forecast note appears at all")
    func unconfiguredStateShowsNoNote() {
        for connection in [SolarForecastConnectionState.notConnected] {
            for enhancement in [SolarForecastEnhancementState.basic, .disconnectedBasic, .loadingWithBasic, .failedWithBasic] {
                let overlay = LoadTimingForecastPresentation.overlay(
                    enhancement: enhancement,
                    connection: connection,
                    cause: nil,
                    result: Self.unavailable(.incompleteCoverage),
                    forecastFetchedAt: nil,
                    contextAsOf: nil,
                    currencyCode: "USD",
                    timeZone: "UTC",
                    now: Self.now
                )
                #expect(overlay.note == nil, "No key means no forecast note to show")
            }
        }
    }

    @Test("An incomplete array selection explains the remaining setup step without promising values")
    func incompleteSelectionExplainsSetup() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .basic,
            connection: .awaitingArraySelection,
            cause: nil,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.contains("Choose your solar arrays"))
        #expect(!overlay.isForecastAware)
    }

    @Test("The first load says the basic estimate already works while it waits")
    func pendingFirstLoadReassures() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .loadingWithBasic,
            connection: .ready,
            cause: nil,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.contains("Checking your solar forecast"))
        #expect(note.contains("already works without it"))
        #expect(overlay.enhanced == nil)
    }

    @Test("A missing tariff stays a basic unavailable state with no fabricated forecast cost")
    func missingTariffStaysBasicUnavailable() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.unavailable(.missingTariff),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
        #expect(!overlay.isForecastAware)
        // The connection is configured, so the user is told why nothing is
        // forecast-aware — but no cost is invented to fill the gap.
        #expect(overlay.note?.contains("using tariff and balance data") == true)
        #expect(!overlay.allText.joined(separator: " ").contains("$"))
    }

    @Test("A zero-charge car keeps the basic outcome and adds no forecast section")
    func zeroChargeCarKeepsBasicOutcome() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.unavailable(.noEnergyNeeded),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
        #expect(!overlay.isForecastAware)
        #expect(overlay.note == nil)
    }

    @Test("Recovery restores the enhanced section after a failure without any user action")
    func recoveryRestoresEnhancement() throws {
        let failed = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: .rateLimited,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let recovered = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(failed.enhanced == nil)
        #expect(recovered.enhanced != nil)
        #expect(recovered.isForecastAware)
        #expect(recovered.note == nil)
    }

    @Test("Forecast-aware costs use the response currency, including a zero-decimal one")
    func enhancedCostsHonorResponseCurrency() throws {
        let jpy = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison(costNow: 340, recommendedCost: 220, savings: 120)),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "JPY",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(jpy.enhanced)

        #expect(enhanced.costNow.contains("340"))
        #expect(enhanced.costNow.contains("220") == false)
        #expect(enhanced.savings?.contains("120") == true)
    }

    @Test("A forecast-aware overlay reads its numbers before its caveats for assistive technology")
    func overlayAccessibilityOrderIsStable() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let label = overlay.accessibilityLabel

        #expect(label.contains("$3.40"))
        #expect(label.contains("$2.20"))
        #expect(label.contains("2.1 kWh"))
        #expect(Self.normalized(label).contains("Compared 8:00 AM – 6:00 PM"))
        let costIndex = try #require(label.range(of: "$2.20"))
        let caveatIndex = try #require(label.range(of: "typical household and battery behavior"))
        #expect(costIndex.lowerBound < caveatIndex.lowerBound)
    }

    /// iOS 17+ `DateFormatter` separates a time from its AM/PM marker with a
    /// narrow no-break space. Normalize it so these assertions test the copy
    /// rather than the platform's choice of space character.
    private static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    @Test("A spent daily allowance is not mistaken for a stale forecast")
    func budgetExhaustedNoteDoesNotAskForAnImpossibleRetry() throws {
        for cause in [SolarForecastUnavailableCause.budgetExhausted, .deferred] {
            let overlay = LoadTimingForecastPresentation.overlay(
                enhancement: .failedWithBasic,
                connection: .ready,
                cause: cause,
                result: Self.unavailable(.incompleteCoverage),
                forecastFetchedAt: nil,
                contextAsOf: nil,
                currencyCode: "USD",
                timeZone: "UTC",
                now: Self.now
            )
            let note = try #require(overlay.note)

            #expect(note.contains("using tariff and balance data"))
            #expect(!note.contains("Retry a refresh"), "\(cause) must not send the user to retry an exhausted budget")
            #expect(!note.lowercased().contains("too old or incomplete"), "\(cause) must not blame forecast age")
            #expect(overlay.enhanced == nil)
        }
    }

    @Test("A stale billing balance is reported as stale energy data, not a Solcast problem")
    func staleBalanceNoteNamesTheRightSubsystem() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            result: Self.unavailable(.staleBalance),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.lowercased().contains("energy observations"))
        #expect(!note.lowercased().contains("solcast"))
        #expect(!note.lowercased().contains("too old or incomplete"))
    }

    @Test("A run longer than the search horizon says so instead of blaming the forecast")
    func noFittingRunNoteExplainsTheHorizon() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            result: Self.unavailable(.noFittingRun),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.contains("search horizon"))
        #expect(!note.lowercased().contains("too old or incomplete"))
    }

    @Test("A forecast older than the recommendation window cannot produce a new recommendation")
    func staleForecastCannotProduceARecommendation() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(-6 * 60 * 60 - 60),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
        #expect(!overlay.isForecastAware)
        #expect(overlay.note?.contains("too old") == true)
    }

    @Test("A forecast inside the recommendation window still produces a recommendation")
    func freshForecastStillRecommends() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(-6 * 60 * 60),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced != nil)
        #expect(overlay.isForecastAware)
    }

    @Test("A forecast with no recorded fetch time cannot produce a recommendation")
    func missingFetchTimeCannotRecommend() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: nil,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
    }

    @Test("A saving too small to render is not advertised as a saving")
    func subMinorSavingIsNotAdvertised() throws {
        // 0.4 of a cent rounds to "$0.00", which would read as nonsense.
        for alternative in [0.0001, 0.004] {
            let overlay = LoadTimingForecastPresentation.overlay(
                enhancement: .enhanced,
                connection: .ready,
                cause: nil,
                result: Self.enhanced(Self.waitingComparison(
                    recommendedStart: Self.now, recommendedEnd: Self.now.addingTimeInterval(3600),
                    recommendedCost: 3.40, savings: 0, bestAlternativeSavings: alternative)),
                forecastFetchedAt: Self.now,
                contextAsOf: Self.now,
                currencyCode: "USD",
                timeZone: "UTC",
                now: Self.now
            )
            let enhanced = try #require(overlay.enhanced)

            #expect(enhanced.headline == "Start now — no cheaper start was found",
                    "A \(alternative) saving must not be advertised")
            #expect(enhanced.savings == nil)
            #expect(!enhanced.headline.contains("$0.00"))
        }
    }

    @Test("A saving worth one cent is still explained")
    func minorUnitSavingIsExplained() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison(
                recommendedStart: Self.now, recommendedEnd: Self.now.addingTimeInterval(3600),
                recommendedCost: 3.34, savings: 0, bestAlternativeSavings: 0.06)),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(overlay.enhanced)

        #expect(enhanced.headline == "Start now — waiting would save about $0.06, which is not worth delaying")
    }

    @Test("The forecast is still shown when no load fits the observed surplus")
    func forecastIsPlacedWhenNoLoadFitsSurplus() throws {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 8, durationHours: 2, carSettings: nil)
        // A deficit: nothing fits, so the basic layer has no suggestion at all.
        let candidate = LoadTimingRecommendation.Candidate(
            profile: washer,
            result: .estimate(.init(total: 4, finishTime: Self.now.addingTimeInterval(7200), batteryKwh: 0,
                                    wallKwh: 8, durationHours: 2, segments: [], hasUnobservedBalance: false)),
            remainingSurplusKwh: nil
        )
        let recommendation = LoadTimingRecommendation(candidates: [candidate], suggested: nil, state: .noFit)
        #expect(recommendation.suggested == nil)

        let placement = try #require(
            LoadTimingForecastPresentation.placement(recommendation: recommendation, explicitExploredID: nil)
        )

        #expect(placement.profile.id == "washer", "A deficit must not hide the forecast entirely")
    }

    @Test("The forecast sits on the recommendation card when it matches the suggested load")
    func forecastSitsOnRecommendationCardForSuggestion() throws {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)
        let candidate = LoadTimingRecommendation.Candidate(profile: washer, result: .noCharge, remainingSurplusKwh: 0)
        let recommendation = LoadTimingRecommendation(candidates: [candidate], suggested: candidate, state: .ready)

        let placement = try #require(
            LoadTimingForecastPresentation.placement(recommendation: recommendation, explicitExploredID: nil)
        )

        #expect(placement.card == .recommendation)
        #expect(placement.profile.id == "washer")
    }

    @Test("The forecast moves to the explorer when a different load is chosen")
    func forecastMovesToExplorerForExplicitChoice() throws {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)
        let car = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
                              carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level2))
        let washerCandidate = LoadTimingRecommendation.Candidate(profile: washer, result: .noCharge, remainingSurplusKwh: 0)
        let carCandidate = LoadTimingRecommendation.Candidate(profile: car, result: .noCharge, remainingSurplusKwh: 0)
        let recommendation = LoadTimingRecommendation(candidates: [washerCandidate, carCandidate], suggested: washerCandidate, state: .ready)

        let placement = try #require(
            LoadTimingForecastPresentation.placement(recommendation: recommendation, explicitExploredID: "car")
        )

        #expect(placement.card == .explorer)
        #expect(placement.profile.id == "car")
    }

    @Test("There is nowhere to place a forecast when the user has no load profiles")
    func forecastPlacementIsEmptyWithoutProfiles() {
        let recommendation = LoadTimingRecommendation(candidates: [], suggested: nil, state: .noCandidates)

        #expect(LoadTimingForecastPresentation.placement(recommendation: recommendation, explicitExploredID: nil) == nil)
    }

    private static func enhanced(
        _ comparison: LoadTimingForecastEstimator.Comparison
    ) -> LoadTimingForecastEstimator.Result {
        LoadTimingForecastEstimator.Result(comparison: comparison, unavailableReason: nil)
    }

    private static func unavailable(
        _ reason: LoadTimingForecastEstimator.UnavailableReason
    ) -> LoadTimingForecastEstimator.Result {
        LoadTimingForecastEstimator.Result(comparison: nil, unavailableReason: reason)
    }

    private static func waitingComparison(
        recommendedStart: Date = Date(timeIntervalSince1970: 1_800_007_200),
        recommendedEnd: Date = Date(timeIntervalSince1970: 1_800_010_800),
        costNow: Double = 3.40,
        recommendedCost: Double = 2.20,
        savings: Double = 1.20,
        bestAlternativeSavings: Double? = nil
    ) -> LoadTimingForecastEstimator.Comparison {
        LoadTimingForecastEstimator.Comparison(
            costNow: costNow,
            recommendedStart: recommendedStart,
            recommendedEnd: recommendedEnd,
            recommendedCost: recommendedCost,
            savings: savings,
            bestAlternativeSavings: bestAlternativeSavings ?? savings,
            estimatedSolarContribution: 2.1,
            horizonStart: Date(timeIntervalSince1970: 1_800_000_000),
            horizonEnd: Date(timeIntervalSince1970: 1_800_036_000),
            evaluatedStarts: [Date(timeIntervalSince1970: 1_800_000_000), recommendedStart],
            assumptions: []
        )
    }
}
