import Testing
@testable import PWUsage

@Suite("Load Timing Presentation Tests")
struct LoadTimingViewTests {
    @Test("Dashboard summary shows active rate and measured surplus or deficit")
    func dashboardSummaryShowsActivePeriodAndMeasuredBalance() {
        let surplus = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Off peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.12, basis: "sell", balanceKwh: 10, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(surplus.title == "Off peak")
        #expect(surplus.rate == "12¢/kWh")
        #expect(surplus.balance == "Surplus 10.0 kWh")

        let deficit = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.48, basis: "buy", balanceKwh: -5, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(deficit.balance == "Deficit 5.0 kWh")
    }

    @Test("Unobserved active period shows configured buy rate and no balance yet")
    func unobservedActivePeriodShowsConfiguredBuyRate() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: nil, basis: "unobserved", balanceKwh: nil, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(summary.rate == "48¢/kWh")
        #expect(summary.balance == "No balance yet")
    }

    @Test("Missing tariff and missing summary are unavailable, while stale data stays dated")
    func summaryShowsUnavailableAndStaleStates() {
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

    @Test("Detail state explains missing tariff, cycle data, and stale source")
    func detailStateExplainsMissingAndStaleData() {
        #expect(LoadTimingPresentation.emptyMessage(hasTariff: false, hasCycleData: false) == "No active tariff is configured for this site.")
        #expect(LoadTimingPresentation.emptyMessage(hasTariff: true, hasCycleData: false) == "Recommendations will appear after energy is recorded in this billing cycle.")
        #expect(LoadTimingPresentation.sourceStatus(isUnavailable: true, energyDataThrough: nil) == "Refresh unavailable · source time unavailable")
    }

    @Test("Custom load amount stays within one through one hundred kWh")
    func customAmountValuesStayWithinSupportedRange() {
        #expect(LoadTimingEstimator.customAmount(0) == 1)
        #expect(LoadTimingEstimator.customAmount(42.5) == 42.5)
        #expect(LoadTimingEstimator.customAmount(120) == 100)
    }

    @Test("Unknown active tariff label is not presented as a configured tariff")
    func unknownTariffLabelRemainsUnavailable() {
        #expect(DashboardPresentation.hasActiveTariff(label: nil) == false)
        #expect(DashboardPresentation.hasActiveTariff(label: "Unknown") == false)
        #expect(DashboardPresentation.hasActiveTariff(label: "  unknown  ") == false)
        #expect(DashboardPresentation.hasActiveTariff(label: "Residential TOU") == true)
    }

    @Test("Live rate stays hidden until bill currency is known")
    func liveSummaryWaitsForCurrency() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.485, sellRate: 0.12, marginalCost: 0.485, basis: "buy", balanceKwh: 2, energyDataThrough: nil),
            hasTariff: true,
            isStale: false
        )
        #expect(summary.rate == nil)
        #expect(!summary.accessibilityLabel.contains("cents per kilowatt-hour"))

        let localized = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.485, sellRate: 0.12, marginalCost: 0.485, basis: "buy", balanceKwh: 2, energyDataThrough: nil),
            hasTariff: true,
            isStale: false,
            currencyCode: "USD"
        )
        #expect(localized.rate == "48.5¢/kWh")
        #expect(localized.accessibilityLabel.contains("48.5 cents per kilowatt-hour"))
    }

    @Test("Selected preset supplies its own tightness threshold and unknown coverage stays unknown")
    func estimateUsesSelectedProfileHeadroomAndDoesNotInventCoverage() {
        let period = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: 15, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let laundry = LoadTimingEstimator.profiles[0]
        let estimate = LoadTimingPresentation.estimate(amount: laundry.kwh, period: period, selectedProfile: laundry)
        #expect(estimate.verdict == .tight)
        #expect(LoadTimingPresentation.coverageSummary(estimate) == "8.0 kWh covered · 0.0 kWh bought")

        let configuredButUnobserved = LoadTimingPeriod(name: "Unobserved", marginalCost: nil, basis: "unobserved", cycleNetExportKwh: 0, isActive: false, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let unobservedEstimate = LoadTimingPresentation.estimate(amount: 100, period: configuredButUnobserved, selectedProfile: laundry)
        #expect(unobservedEstimate.verdict == .bought)
        #expect(unobservedEstimate.total == 48)

        let unpriced = LoadTimingPeriod(name: "Unknown", marginalCost: nil, basis: "unknown", cycleNetExportKwh: 0, isActive: false, nextStartPhrase: nil, buyRate: 0, sellRate: 0)
        let unknown = LoadTimingPresentation.estimate(amount: 100, period: unpriced, selectedProfile: laundry)
        #expect(unknown.verdict == .unknown)
        #expect(LoadTimingPresentation.coverageSummary(unknown) == "Coverage unavailable")
    }

    @Test("Car charge calculation flows into the period cost estimate")
    func carChargeCalculationFeedsPeriodEstimate() {
        let amount = LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: 80)
        let period = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: 10, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let estimate = LoadTimingPresentation.estimate(amount: amount, period: period, selectedProfile: nil)
        #expect(amount == 36)
        #expect(estimate.coveredKwh == 10)
        #expect(estimate.boughtKwh == 26)
        #expect(estimate.total == 13.68)
        #expect(LoadTimingPresentation.coverageSummary(estimate) == "10.0 kWh covered · 26.0 kWh bought")
    }

    @Test("Car limited-headroom verdict uses a threshold based on the planned charge")
    func carEstimateUsesDynamicHeadroomThreshold() {
        let plannedKwh = LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: 80)
        let car = LoadTimingEstimator.Profile(id: "car", label: "Car", kwh: plannedKwh, headroomKwh: LoadTimingEstimator.carHeadroomKwh(plannedKwh: plannedKwh))
        let period = LoadTimingPeriod(name: "Off peak", marginalCost: 0.12, basis: "sell", cycleNetExportKwh: 40, isActive: false, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let estimate = LoadTimingPresentation.estimate(amount: plannedKwh, period: period, selectedProfile: car)
        #expect(car.headroomKwh == 57.6)
        #expect(estimate.verdict == .tight)
    }

    @Test("Successful bill response without load timing shows unavailable, not loading")
    func missingLoadTimingResponseIsUnavailable() {
        #expect(LoadTimingPresentation.detailState(hasBillResponse: true, hasLoadTiming: false, isUnavailable: false) == .unavailable("Configure a tariff or check its rates on the website to make load timing available."))
        #expect(LoadTimingPresentation.detailState(hasBillResponse: false, hasLoadTiming: false, isUnavailable: false) == .loading)
    }

    @Test("Estimator accessibility summary includes rate, start, cost, and coverage split")
    func estimateAccessibilitySummaryIncludesVisibleDetails() {
        let period = LoadTimingPeriod(name: "Off peak", marginalCost: 0.12, basis: "sell", cycleNetExportKwh: 4, isActive: false, nextStartPhrase: "in 2 hours", buyRate: 0.48, sellRate: 0.12)
        let estimate = LoadTimingEstimator.costToRun(10, pricing: .init(surplusKwh: 4, buyRate: 0.48, sellRate: 0.12))
        let label = LoadTimingPresentation.estimateAccessibilityLabel(
            period: period,
            estimate: estimate,
            startPhrase: "in 2 hours",
            verdict: "Partly covered by cycle surplus",
            currencyCode: "USD"
        )
        #expect(label.contains("12 cents per kilowatt-hour"))
        #expect(label.contains("Starts in 2 hours"))
        #expect(label.contains("estimated cost $3.36"))
        #expect(label.contains("4.0 kilowatt-hours covered"))
        #expect(label.contains("6.0 kilowatt-hours bought"))
    }

    @Test("Estimator periods put the active period first")
    func estimatorPeriodsPutActivePeriodFirst() {
        let future = LoadTimingPeriod(name: "Off peak", marginalCost: 0.12, basis: "sell", cycleNetExportKwh: 10, isActive: false, nextStartPhrase: "in 2 hours", buyRate: 0.2, sellRate: 0.12)
        let active = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: -2, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let unobserved = LoadTimingPeriod(name: "Shoulder", marginalCost: nil, basis: "unobserved", cycleNetExportKwh: 0, isActive: false, nextStartPhrase: "tomorrow", buyRate: 0.3, sellRate: 0.08)
        #expect(LoadTimingPresentation.orderedPricingPeriods([future, active, unobserved]).map(\.name) == ["Peak", "Off peak", "Shoulder"])
    }

    @Test("Cycle data controls estimator visibility")
    func cycleDataControlsEstimatorVisibility() {
        #expect(LoadTimingPresentation.shouldShowEstimator(hasCycleData: false) == false)
        #expect(LoadTimingPresentation.shouldShowEstimator(hasCycleData: true) == true)
    }

    @Test("Action panel presents the largest covered load, balance, and next shortfall")
    func actionPanelShowsRunnableLoadAndNextShortfall() {
        let affordance = LoadTimingAffordance.evaluate(timing: actionTiming(balance: 17), plannedCarKwh: 30)
        #expect(LoadTimingPresentation.actionTitle(for: affordance) == "Dishwasher")
        #expect(LoadTimingPresentation.actionContext(for: affordance) == "Peak · Surplus 17.0 kWh")
        #expect(LoadTimingPresentation.actionNextStep(for: affordance) == "Next: Laundry needs 3.0 kWh more")
        #expect(LoadTimingPresentation.actionAccessibilityLabel(for: affordance).contains("Can run now. Dishwasher."))
    }

    @Test("Action panel warns when no large load is covered and preserves cheaper period advice")
    func actionPanelShowsCautionAndCheaperAdvice() {
        let affordance = LoadTimingAffordance.evaluate(timing: actionTiming(
            balance: -4,
            nextCheaper: .init(name: "Off peak", marginalCost: 0.12, phrase: "in 2 hours")
        ), plannedCarKwh: 30)
        #expect(LoadTimingPresentation.actionTitle(for: affordance) == "Avoid large loads")
        #expect(LoadTimingPresentation.actionContext(for: affordance) == "Peak · Deficit 4.0 kWh")
        #expect(LoadTimingPresentation.actionNextStep(for: affordance) == "Next: Dishwasher needs 9.0 kWh more")
        #expect(LoadTimingPresentation.actionCheaperAdvice(affordance.nextCheaper) == "Cheaper in Off peak · 12¢/kWh · in 2 hours")
        #expect(LoadTimingPresentation.actionAccessibilityLabel(for: affordance).contains("12 cents per kilowatt-hour"))
    }

    @Test("Action panel explains when the active period balance is unobserved")
    func actionPanelExplainsUnobservedBalance() {
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [], pricingPeriods: [], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let affordance = LoadTimingAffordance.evaluate(timing: timing, plannedCarKwh: 30)
        #expect(LoadTimingPresentation.actionTitle(for: affordance) == "Balance not recorded yet")
        #expect(LoadTimingPresentation.actionContext(for: affordance) == "This period's balance is not recorded yet.")
    }

    private func actionTiming(balance: Double, nextCheaper: NextCheaperPeriod? = nil) -> LoadTiming {
        let active = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: balance, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        return LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [active], pricingPeriods: [active], nextCheaper: nextCheaper, nextCheaperPhrase: nextCheaper?.phrase, nextStartPhraseByKey: [:])
    }
}
