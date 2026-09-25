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
        #expect(surplus.rate == "$0.12/kWh")
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
        #expect(summary.rate == "$0.48/kWh")
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

    @Test("Custom load slider values clamp to one through one hundred kWh")
    func customSliderValuesStayWithinSupportedRange() {
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

    @Test("Live rate uses currency-neutral cents until bill currency is known")
    func liveSummaryUsesNeutralRate() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.485, sellRate: 0.12, marginalCost: 0.485, basis: "buy", balanceKwh: 2, energyDataThrough: nil),
            hasTariff: true,
            isStale: false
        )
        #expect(summary.rate == "48.5¢/kWh")
        #expect(summary.accessibilityLabel.contains("49 cents per kilowatt-hour"))
    }

    @Test("Selected preset supplies its own tightness threshold and unknown coverage stays unknown")
    func estimateUsesSelectedProfileHeadroomAndDoesNotInventCoverage() {
        let period = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: 120, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let bigCar = LoadTimingEstimator.profiles[0]
        let estimate = LoadTimingPresentation.estimate(amount: 100, period: period, selectedProfile: bigCar)
        #expect(estimate.verdict == .tight)
        #expect(LoadTimingPresentation.coverageSummary(estimate) == "100.0 kWh covered · 0.0 kWh bought")

        let configuredButUnobserved = LoadTimingPeriod(name: "Unobserved", marginalCost: nil, basis: "unobserved", cycleNetExportKwh: 0, isActive: false, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let unobservedEstimate = LoadTimingPresentation.estimate(amount: 100, period: configuredButUnobserved, selectedProfile: bigCar)
        #expect(unobservedEstimate.verdict == .bought)
        #expect(unobservedEstimate.total == 48)

        let unpriced = LoadTimingPeriod(name: "Unknown", marginalCost: nil, basis: "unknown", cycleNetExportKwh: 0, isActive: false, nextStartPhrase: nil, buyRate: 0, sellRate: 0)
        let unknown = LoadTimingPresentation.estimate(amount: 100, period: unpriced, selectedProfile: bigCar)
        #expect(unknown.verdict == .unknown)
        #expect(LoadTimingPresentation.coverageSummary(unknown) == "Coverage unavailable")
    }

    @Test("Next cheaper recommendation takes precedence over cheapest-now cue")
    func nextCheaperCueTakesPrecedence() {
        let next = NextCheaperPeriod(name: "Off peak", marginalCost: 0.12, phrase: "in 2 hours")
        let timing = LoadTiming(
            hasTariff: true,
            hasCycleData: true,
            activeIsCheapest: true,
            periods: [],
            pricingPeriods: [],
            nextCheaper: next,
            nextCheaperPhrase: "in 2 hours",
            nextStartPhraseByKey: [:]
        )
        #expect(LoadTimingPresentation.recommendationCue(timing) == .nextCheaper(next))
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

    @Test("Cycle data controls estimator visibility and gives a clear no-data cue")
    func cycleDataControlsEstimatorVisibility() {
        #expect(LoadTimingPresentation.shouldShowEstimator(hasCycleData: false) == false)
        #expect(LoadTimingPresentation.shouldShowEstimator(hasCycleData: true) == true)
        let timing = LoadTiming(hasTariff: true, hasCycleData: false, activeIsCheapest: false, periods: [], pricingPeriods: [], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        #expect(LoadTimingPresentation.recommendationCue(timing) == .noCycleData)
    }
}
