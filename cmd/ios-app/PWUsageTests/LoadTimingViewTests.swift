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
        #expect(summary.balance == "Banked 10.0 kWh")
        #expect(summary.isBanked)
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
        #expect(summary.balance == "No bank yet")
        #expect(!summary.isBanked)
    }

    @Test("Live tariff summary preserves missing tariff and stale source cues")
    func dashboardSummaryRetainsUnavailableAndStaleStates() {
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: false, isStale: false).message == "No rate plan is set up")
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: true, isStale: false).message == "No live summary is available")
        let stale = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.48, basis: "buy", balanceKwh: -4, energyDataThrough: nil),
            hasTariff: true,
            isStale: true,
            currencyCode: "USD"
        )
        #expect(stale.freshness == "Showing the last successful live summary")
        #expect(stale.balance == "Owed 4.0 kWh")
        #expect(!stale.isBanked)
        let unobservedWithBalance = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: nil, basis: "unobserved", balanceKwh: 5, energyDataThrough: nil),
            hasTariff: true,
            isStale: false
        )
        #expect(unobservedWithBalance.balance == "No bank yet")
        #expect(!unobservedWithBalance.isBanked)
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
        #expect(LoadTimingPresentation.actionTitle(for: edited) == "Washer")

        let editedCar = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 999, durationHours: 999, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 50, chargingLevel: .level1))
        #expect(LoadTimingPresentation.profileChipTitle(editedCar) == "Car · 32 kWh battery")
        #expect(LoadTimingPresentation.profileChipAccessibilityLabel(editedCar).contains("37.6 kilowatt-hours from the wall"))
    }

    @Test("Active observed balance and source time have explicit labels")
    func currentBalanceAndSourceTimeAreExplained() {
        let active = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: 4.2, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [active], pricingPeriods: [active], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        #expect(LoadTimingPresentation.activeBalanceSummary(timing) == "Current Peak bank: 4.2 kWh banked.")

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
        #expect(rows[1].balance == "2.0 kWh from your bank · 2.0 kWh at the full rate")
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
        #expect(row?.balance == "No bank observed · priced at the full rate")
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
        #expect(LoadTimingPresentation.missingBalanceNote(hasUnobservedBalance: estimate.hasUnobservedBalance) != nil)
    }

    @Test("Run card outcomes preserve no-charge and unavailable messages")
    func runCardOutcomesRemainClear() {
        #expect(LoadTimingPresentation.noChargeMessage == "No charging needed at this target.")
        #expect(LoadTimingPresentation.unavailableMessage(.incompleteTimeline).contains("unavailable"))
    }

    @Test("Recommendation copy distinguishes ready, no fit, stale, incomplete, no energy, and empty profiles")
    func recommendationMessagesExplainEachState() {
        #expect(LoadTimingPresentation.recommendationMessage(for: .ready).title == "Good time to start")
        #expect(LoadTimingPresentation.recommendationMessage(for: .ready).detail == "Your bank covers this job.")
        #expect(LoadTimingPresentation.recommendationMessage(for: .noFit).title == "No saved job fits your bank.")
        #expect(LoadTimingPresentation.recommendationMessage(for: .noFit, refreshUnavailable: true).detail.contains("refresh failed"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .stale).detail.contains("older than one hour"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .stale, refreshUnavailable: true).detail.contains("refresh failed"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .incompleteData, hasTariff: false).detail.contains("rate plan"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .incompleteData, hasExpiredCandidate: true).detail.contains("billing cycle"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .noEnergyNeeded).detail.contains("already at its target"))
        #expect(LoadTimingPresentation.recommendationMessage(for: .noCandidates).detail.contains("Add a job"))
    }

    /// `.incompleteData` is aggregated across every job, but the card speaks about
    /// the selected one. Blaming the selected job's rate plan when another job is
    /// the one crossing the billing cycle sent people to fix a rate plan that was fine.
    @Test("Incomplete-data copy names the job that crosses the billing cycle")
    func incompleteDataCopyNamesTheExpiredJob() {
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5, durationHours: 2, carSettings: nil)
        let car = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 90, chargingLevel: .level1))
        let estimate = LoadTimingEstimator.StartNowEstimate(total: 1, finishTime: .now.addingTimeInterval(7200), batteryKwh: 3.5, wallKwh: 3.5, durationHours: 2, segments: [], hasUnobservedBalance: false)
        let washerCandidate = LoadTimingRecommendation.Candidate(profile: washer, result: .estimate(estimate), remainingSurplusKwh: 0)
        let carCandidate = LoadTimingRecommendation.Candidate(profile: car, result: .unavailable(.billingCycleExpired), remainingSurplusKwh: nil)
        let recommendation = LoadTimingRecommendation(candidates: [washerCandidate, carCandidate], suggested: nil, state: .incompleteData)

        let otherExpired = LoadTimingPresentation.recommendationMessage(for: recommendation, selected: washerCandidate)
        #expect(otherExpired.title == "No safe recommendation")
        #expect(otherExpired.detail.contains("Another saved job"))

        let selectedExpired = LoadTimingPresentation.recommendationMessage(for: recommendation, selected: carCandidate)
        #expect(selectedExpired.detail.hasPrefix("This job would continue beyond the current billing cycle"))

        let incomplete = LoadTimingRecommendation(
            candidates: [LoadTimingRecommendation.Candidate(profile: washer, result: .unavailable(.incompleteTimeline), remainingSurplusKwh: nil)],
            suggested: nil,
            state: .incompleteData
        )
        #expect(LoadTimingPresentation.recommendationMessage(for: incomplete, selected: incomplete.candidates[0]).title == "Rate plan incomplete")
    }

    @Test("Action titles use the Job's verb-phrase name as-is")
    func recommendationAndExplorationTitlesNameProfileKind() {
        let washer = LoadProfile(id: "washer", name: "Wash the laundry", kind: .appliance, energyKwh: 3.5, durationHours: 2, carSettings: nil)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 50, chargingLevel: .level2))
        #expect(LoadTimingPresentation.actionTitle(for: washer) == "Wash the laundry")
        #expect(LoadTimingPresentation.actionTitle(for: car) == "Charge the car")
    }

    @Test("Energy impact explains surplus used, buy-rate energy, and known or unknown remaining balance")
    func energyImpactShowsOnlyKnownRemainingSurplus() {
        let segment = LoadTimingEstimator.StartNowSegment(periodKey: "Peak", start: .now, end: .now.addingTimeInterval(3600), wallKwh: 5, surplusKwh: 1.5, boughtKwh: 3.5, total: 1.25)
        let estimate = LoadTimingEstimator.StartNowEstimate(total: 1.25, finishTime: .now, batteryKwh: 0, wallKwh: 5, durationHours: 1, segments: [segment], hasUnobservedBalance: false)
        let candidate = LoadTimingRecommendation.Candidate(profile: LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 5, durationHours: 1, carSettings: nil), result: .estimate(estimate), remainingSurplusKwh: 3.5)
        let impact = LoadTimingPresentation.energyImpact(candidate)
        #expect(impact.surplusConsumed == "1.5 kWh from your bank")
        #expect(impact.energyBought == "3.5 kWh at the full rate")
        #expect(impact.remainingSurplus == "3.5 kWh remains in your bank in these rate periods")
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
        #expect(LoadTimingPresentation.noResponseExplorationMessage.contains("bill response and rate plan"))
        #expect(LoadTimingPresentation.noResponseExplorationMessage.contains("estimate or calculation"))
    }

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
        #expect(enhanced.costNow == "Start now. Adds \(Self.money(3.40)) to your projected bill")
        #expect(Self.normalized(enhanced.recommendedCost)
            == Self.normalized("Start at 10:00 AM. Adds \(Self.money(2.20)) to your projected bill"))
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
        #expect(enhanced.headline == "Start now. No cheaper start was found")
        #expect(enhanced.savings == nil)
        #expect(enhanced.costNow == "Start now. Adds $3.40 to your projected bill")
        #expect(Self.normalized(enhanced.recommendedCost) == Self.normalized("Start now. Adds $3.40 to your projected bill"))
    }

    /// `costNow`/`recommendedCost` are the *marginal* cost of the load against the
    /// projected household baseline, not the absolute cost of the energy involved.
    /// When the load is served by stored surplus that marginal cost is legitimately
    /// near zero, and the energy was already paid for. Copy that rendered the figure
    /// as a total ("Start now: $0.00") would read as "this run is free" — or worse,
    /// make a real marginal cost look like a total. So the rendered form must state
    /// that the figure is added to the bill.
    @Test("A near-zero marginal cost is labelled as an addition to the bill, never as a total")
    func nearZeroMarginalCostIsNotPresentedAsAnAbsoluteTotal() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison(costNow: 0.01, recommendedCost: 0, savings: 0.01)),
            forecastFetchedAt: Self.now,
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let enhanced = try #require(overlay.enhanced)

        // Built through the same formatter production uses, so this test asserts
        // the copy rather than the device's currency symbols or decimal separators.
        let marginalNow = Self.money(0.01)
        let marginalLater = Self.money(0)

        #expect(enhanced.costNow == "Start now. Adds \(marginalNow) to your projected bill")
        #expect(Self.normalized(enhanced.recommendedCost)
            == Self.normalized("Start at 10:00 AM. Adds \(marginalLater) to your projected bill"))

        // The substantive property: neither may be readable as a standalone total.
        for rendered in [enhanced.costNow, enhanced.recommendedCost] {
            #expect(rendered.hasSuffix(" to your projected bill"),
                    "Cost copy must say what the figure is added to, got \"\(rendered)\"")
        }
        // A bare "Start now. $X" form would read as a total, and only `costNow`
        // can carry it; `recommendedCost` is checked by the equality above.
        #expect(!enhanced.costNow.contains("Start now. $"), "Cost copy must not read as a total")
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

        #expect(enhanced.headline == "Start now. Waiting would save about $0.04, which is not worth delaying")
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

    @Test("A short recent history explains the recent window, not a total lack of history")
    func shortHistoryNoteExplainsTheRecentWindow() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            enhancementReason: .insufficientHistory,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.contains("last 14 days"),
                "The note must not imply the site has no history at all")
        #expect(note.lowercased().contains("5"), "It should say how many complete days are needed")
    }

    @Test("A misaligned history is named as a timestamp problem, not a short one")
    func misalignedHistoryNoteNamesTimestamps() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            enhancementReason: .timestampMisaligned,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.lowercased().contains("timestamps"))
        #expect(!note.contains("last 14 days"),
                "A timestamp problem is not a short-history problem")
    }

    @Test("A missing household history is named as such, not blamed on the forecast")
    func missingContextNoteNamesTheRealBlocker() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            enhancementReason: .contextUnavailable,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(note.lowercased().contains("household profile"))
        #expect(!note.lowercased().contains("too old or incomplete"))
        #expect(!note.lowercased().contains("retry a refresh"),
                "The copy must not promise an action that does not exist")
    }

    /// `contextInvalid` is what a mis-set *device* clock produces: `asOf` is stamped
    /// by the server and read against the local clock. The note used to say "The
    /// server sent household data this app could not read. Please report this", which
    /// sends the user to file a server bug that does not exist.
    @Test("An unreadable household profile points at this device's clock, not at a server bug")
    func contextInvalidNoteBlamesTheDeviceClock() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            enhancementReason: .contextInvalid,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(!note.lowercased().contains("report"),
                "The device must not be told to report a server bug that is really its own clock")
        #expect(note.lowercased().contains("date and time"),
                "The note should name the device's own date and time as the thing to check")
        #expect(note.contains("Using your rate plan and bank data"),
                "The note must still carry the shared prefix about what keeps working")
    }

    /// Regression: the clock advice used to be shown for *every* contract
    /// rejection, including payloads that will never parse however the clock is
    /// set. Sending someone to fix their date for a bad payload is a dead end.
    @Test("A payload the app cannot parse is not blamed on the device clock")
    func contextMalformedNoteDoesNotBlameTheDeviceClock() throws {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .failedWithBasic,
            connection: .ready,
            cause: nil,
            enhancementReason: .contextMalformed,
            result: Self.unavailable(.incompleteCoverage),
            forecastFetchedAt: nil,
            contextAsOf: nil,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        let note = try #require(overlay.note)

        #expect(!note.lowercased().contains("date and time"),
                "Nothing here is fixed by adjusting the clock, so do not tell the user to try")
        #expect(!note.lowercased().contains("report"),
                "Still must not invite a server bug report")
        #expect(note.contains("Using your rate plan and bank data"),
                "The note must still carry the shared prefix about what keeps working")
    }

    @Test("Every unavailable note tells the user something they can actually do")
    func unavailableNotesAreActionable() {
        let reasons: [SolarForecastEnhancementUnavailableReason] = [
            .contextUnavailable, .forecastNotUsable, .billUnavailable, .siteMismatch
        ]
        let causes: [SolarForecastUnavailableCause?] = [
            nil, .unauthorized, .rateLimited, .requestFailed, .unknownResource,
            .invalidForecast, .storageFailure, .cleanupFailure, .budgetExhausted, .deferred
        ]
        for reason in reasons {
            for cause in causes {
                let note = LoadTimingForecastPresentation.overlay(
                    enhancement: .failedWithBasic,
                    connection: .ready,
                    cause: cause,
                    enhancementReason: reason,
                    result: Self.unavailable(.incompleteCoverage),
                    forecastFetchedAt: nil,
                    contextAsOf: nil,
                    currencyCode: "USD",
                    timeZone: "UTC",
                    now: Self.now
                ).note
                #expect(note?.contains("Using your rate plan and bank data") == true)
                #expect(note?.contains("Retry a refresh") == false,
                        "No note may promise a refresh affordance that does not exist")
            }
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
            #expect(note?.contains("Using your rate plan and bank data") == true)
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
        #expect(overlay.note?.contains("Using your rate plan and bank data") == true)
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

    /// Formats money through the same call the production path uses, with the
    /// locale passed explicitly, so these assertions test the copy rather than
    /// the device's currency symbol or decimal separator (§9.13). The production
    /// entry point takes no locale, so pinning one here would be wrong.
    private static func money(_ amount: Double) -> String {
        DashboardPresentation.currency(amount, code: "USD", locale: .current)
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

            #expect(note.contains("Using your rate plan and bank data"))
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

    @Test("A forecast stamped in the future cannot produce a recommendation")
    func futureDatedForecastCannotProduceARecommendation() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(600),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )

        #expect(overlay.enhanced == nil)
        #expect(!overlay.isForecastAware)
        #expect(overlay.note == LoadTimingForecastPresentation.futureDatedForecastNote)
        #expect(overlay.note?.contains("unavailable") == false)
        #expect(overlay.note?.contains("too old") == false,
                "A future-dated forecast is not stale; folding this case back into the stale note must fail")
    }

    @Test("A save failure keeps the forecast and is not reported as unavailable")
    func saveFailureKeepsForecastAndIsNotReportedAsUnavailable() {
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            saveFailed: true,
            result: Self.enhanced(Self.waitingComparison()),
            forecastFetchedAt: Self.now.addingTimeInterval(-60),
            contextAsOf: Self.now,
            currencyCode: "USD",
            timeZone: "UTC",
            now: Self.now
        )
        #expect(overlay.isForecastAware)
        #expect(overlay.note == LoadTimingForecastPresentation.saveFailureNote)
        #expect(overlay.note?.contains("unavailable") == false)
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

            #expect(enhanced.headline == "Start now. No cheaper start was found",
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

        #expect(enhanced.headline == "Start now. Waiting would save about $0.06, which is not worth delaying")
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
            assumptions: [],
            hasUnobservedBalance: false,
            lanes: [],
            periodSwitches: []
        )
    }

    // MARK: - Smart Shift card wiring

    @Test("Forecast states map to what the Smart Shift card can show")
    func forecastAvailabilityMapsStates() throws {
        typealias P = LoadTimingForecastPresentation
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let fresh = now.addingTimeInterval(-25 * 60)
        #expect(P.forecastAvailability(state: .basic, connection: .notConnected, cause: nil, reason: nil,
                                       forecastFetchedAt: nil, now: now) == ForecastAvailability.none)
        #expect(P.forecastAvailability(state: .loadingWithBasic, connection: .ready, cause: nil, reason: nil,
                                       forecastFetchedAt: nil, now: now) == .loading)
        // A refresh keeps the previous batch in memory; while it is still fresh it keeps
        // pricing the card, so the verdict doesn't flip to the forecast-free answer and back.
        #expect(P.forecastAvailability(state: .loadingWithBasic, connection: .ready, cause: nil, reason: nil,
                                       forecastFetchedAt: fresh, now: now) == .ready)
        #expect(P.forecastAvailability(state: .loadingWithBasic, connection: .ready, cause: nil, reason: nil,
                                       forecastFetchedAt: now.addingTimeInterval(-7 * 3600), now: now) == .loading)
        #expect(P.forecastAvailability(state: .basic, connection: .awaitingArraySelection, cause: nil, reason: nil,
                                       forecastFetchedAt: nil, now: now) == .unusable("Choose your solar arrays to add a forecast."))
        #expect(P.forecastAvailability(state: .enhanced, connection: .ready, cause: nil, reason: nil,
                                       forecastFetchedAt: fresh, now: now) == .ready)
        #expect(P.forecastAvailability(state: .failedWithBasic, connection: .ready, cause: .rateLimited, reason: nil,
                                       forecastFetchedAt: fresh, now: now) == .unusable("Solcast is limiting requests."))
        #expect(P.forecastAvailability(state: .failedWithBasic, connection: .ready, cause: nil, reason: .insufficientHistory,
                                       forecastFetchedAt: fresh, now: now)
            == .unusable("Your household profile needs at least 5 complete days in the last 14 days."))
        #expect(P.forecastAvailability(state: .enhanced, connection: .ready, cause: nil, reason: nil,
                                       forecastFetchedAt: now.addingTimeInterval(-7 * 3600), now: now)
            == .unusable("The forecast was too old or incomplete to use."))
        #expect(P.forecastUnavailableNote(.staleBalance)
            == "Energy observations are too old for the solar comparison, so it's paused.")
    }

    @Test("Smart Shift opens on the last Job viewed")
    @MainActor
    func defaultJobIsLastViewed() throws {
        let suiteName = "LoadTimingViewTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let store = LoadProfileStore(userDefaults: defaults)
        #expect(LoadTimingView.initialJobID(store: store) == "car")
        try store.selectProfile(id: "dryer")
        #expect(LoadTimingView.initialJobID(store: LoadProfileStore(userDefaults: defaults)) == "dryer")
    }

    @Test("A forecast comparison that can't run falls back to the forecast-free one and says why")
    func forecastFailureFallsBackToFlat() throws {
        let now = SmartShiftPresentationTests.now
        let timing = SmartShiftPresentationTests.timing()
        let intervals = [SolarForecastInterval(periodStart: SmartShiftPresentationTests.at(0),
                                               periodEnd: SmartShiftPresentationTests.at(48), powerKw: 0)]
        let slots = stride(from: 0, to: 1440, by: 30).map {
            LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: 0, batteryNetChargeKw: 0)
        }
        let context = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: slots, asOf: now)
        func evaluate(_ forecast: ForecastAvailability, sourceAge: TimeInterval?) -> SmartShiftEvaluation {
            SmartShiftPresentation.evaluate(
                profile: SmartShiftPresentationTests.car, now: now, timing: timing, forecast: forecast,
                intervals: forecast == .ready ? intervals : nil, context: forecast == .ready ? context : nil,
                balanceSourceTime: sourceAge.map { now.addingTimeInterval(-$0) },
                billingCycleEnd: now.addingTimeInterval(20 * 86_400), currencyCode: "USD", timeZone: "UTC")
        }

        let fresh = evaluate(.ready, sourceAge: 0)
        #expect(fresh.forecast == .ready)
        #expect(fresh.result.comparison?.assumptions.contains { $0.contains("historical local-time profile") } == true)

        let stale = evaluate(.ready, sourceAge: 40 * 60)
        #expect(stale.result.comparison != nil)
        #expect(stale.forecast == .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(.staleBalance)))

        let none = evaluate(.none, sourceAge: 0)
        #expect(none.forecast == ForecastAvailability.none)
        #expect(none.result.comparison?.assumptions.contains { $0 == "Banks are held at today's observed values; no solar or household use is projected." } == true)
        #expect(none.result.comparison?.assumptions.contains { $0 == "Estimated cost uses each period's current bank through the shared horizon." } == true)
        #expect(none.result.comparison?.assumptions.contains { $0.localizedCaseInsensitiveContains("balance") } == false)

        let missingSource = evaluate(.none, sourceAge: nil)
        #expect(missingSource.result.unavailableReason == .staleBalance)
    }

    @Test("One pass's evaluator prices every Job exactly as evaluating each alone")
    func passEvaluatorMatchesPerJobEvaluation() {
        let now = SmartShiftPresentationTests.now
        let timing = SmartShiftPresentationTests.timing()
        let intervals = [SolarForecastInterval(periodStart: SmartShiftPresentationTests.at(0),
                                               periodEnd: SmartShiftPresentationTests.at(48), powerKw: 2)]
        let slots = stride(from: 0, to: 1440, by: 30).map {
            LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: 0.5, batteryNetChargeKw: 0)
        }
        let context = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: slots, asOf: now)
        let jobs = [SmartShiftPresentationTests.car, SmartShiftPresentationTests.pump,
                    LoadProfile(id: "kettle", name: "Boil the kettle", kind: .appliance, energyKwh: 0.2, durationHours: 0.1, carSettings: nil)]
        for (forecast, sourceAge) in [(ForecastAvailability.ready, 0.0), (.ready, 40.0 * 60), (.none, 0)] {
            let evaluate = SmartShiftPresentation.evaluator(
                now: now, timing: timing, forecast: forecast, intervals: intervals, context: context,
                balanceSourceTime: now.addingTimeInterval(-sourceAge), billingCycleEnd: now.addingTimeInterval(20 * 86_400),
                currencyCode: "USD", timeZone: "UTC")
            for job in jobs {
                let alone = SmartShiftPresentation.evaluate(
                    profile: job, now: now, timing: timing, forecast: forecast, intervals: intervals, context: context,
                    balanceSourceTime: now.addingTimeInterval(-sourceAge), billingCycleEnd: now.addingTimeInterval(20 * 86_400),
                    currencyCode: "USD", timeZone: "UTC")
                #expect(evaluate(job) == alone)
            }
        }
    }
}
