import Foundation
@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    // MARK: - Recompute when the card goes stale

    @Test func nextRefreshIsTheRecommendedStartWhenItComesFirst() {
        // Recommended at 16:30; the next switch is 16:30 too, then 31:00.
        let comparison = Self.comparison(recommendedStart: Self.at(15))
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.now) == Self.at(15))
    }

    @Test func nextRefreshIsTheNextRateSwitchOnceTheStartHasPassed() {
        let comparison = Self.comparison(recommendedStart: Self.at(16.5))
        // After the recommended start (and the 16:30 switch), the next switch is at 31:00.
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.at(17)) == Self.at(31))
    }

    @Test func nextRefreshWhenStartingNowIsTheNextSwitch() {
        let comparison = Self.comparison(costNow: 5, recommendedCost: 5, savings: 0, recommendedStart: Self.now)
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.now) == Self.at(16.5))
    }

    @Test func nextRefreshIsNilWithoutAComparisonOrAnythingAhead() {
        #expect(SmartShiftPresentation.nextRefresh(comparison: nil, now: Self.now) == nil)
        let comparison = Self.comparison(recommendedStart: Self.at(15))
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.at(50)) == nil)
    }

    // MARK: Projection choice and assumptions

    static func historyContext(asOf: Date, forecastHours: Bool = false) -> Estimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map { minute in
            Estimator.PlanningSlot(localMinute: minute, homeKw: 0.5, batteryNetChargeKw: 0,
                                   gridNetExportKw: (480 ..< 1200).contains(minute) ? 2 : -0.5,
                                   cautiousGridNetExportKw: (480 ..< 1200).contains(minute) ? 1 : -0.5)
        }
        return .init(timeZone: "UTC", slots: slots, asOf: asOf)
    }

    @Test func evaluateUsesHistoryWithoutSolcast() throws {
        let harrison = Self.harrisonSunday()
        let evaluation = SmartShiftPresentation.evaluate(
            profile: harrison.car,
            inputs: .init(now: harrison.now, timing: harrison.timing, forecast: .none, intervals: nil,
                          context: Self.historyContext(asOf: harrison.now),
                          balanceSourceTime: harrison.now, billingCycleEnd: Self.at(48),
                          currencyCode: "USD", timeZone: "UTC"))
        let comparison = try #require(evaluation.result.comparison)
        #expect(comparison.usesHistory)
        #expect(comparison.assumptions.contains("Banks follow your last four weeks of grid use through the bill date."))
        #expect(comparison.assumptions.contains(
            "A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."))
        #expect(evaluation.forecast == ForecastAvailability.none)

        // Without grid history the card still holds banks flat.
        let slots = stride(from: 0, to: 1440, by: 30).map {
            Estimator.PlanningSlot(localMinute: $0, homeKw: 0.5, batteryNetChargeKw: 0)
        }
        let flat = SmartShiftPresentation.evaluate(
            profile: harrison.car,
            inputs: .init(now: harrison.now, timing: harrison.timing, forecast: .none, intervals: nil,
                          context: .init(timeZone: "UTC", slots: slots, asOf: harrison.now),
                          balanceSourceTime: harrison.now, billingCycleEnd: Self.at(48),
                          currencyCode: "USD", timeZone: "UTC"))
        #expect(flat.result.comparison?.usesHistory == false)
        #expect(flat.result.comparison?.assumptions.contains { $0.contains("held at today's observed values") } == true)
    }

    @Test func forecastWithHistoryStatesBothSources() throws {
        let harrison = Self.harrisonSunday()
        let intervals = (0 ..< 96).map { index in
            SolarForecastInterval(periodStart: Self.at(Double(index) / 2),
                                  periodEnd: Self.at(Double(index + 1) / 2), powerKw: 1)
        }
        let evaluation = SmartShiftPresentation.evaluate(
            profile: harrison.car,
            inputs: .init(now: harrison.now, timing: harrison.timing, forecast: .ready,
                          intervals: intervals, context: Self.historyContext(asOf: harrison.now),
                          balanceSourceTime: harrison.now, billingCycleEnd: Self.at(48),
                          currencyCode: "USD", timeZone: "UTC"))
        let assumptions = try #require(evaluation.result.comparison).assumptions
        let expectedAssumption = "Solar follows your solar forecast for the next 7 days, "
            + "then your last four weeks through the bill date."
        #expect(assumptions.contains(expectedAssumption))
        #expect(assumptions.contains(
            "A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."))
        #expect(assumptions.contains(
            "Typical household and battery behavior follows the historical local-time profile."))
    }

    @Test func aLoadingForecastShowsNoVerdictYet() {
        // Priced from history first and the forecast a moment later, the card would flash
        // one answer and then another, so it waits for the forecast instead.
        #expect(Self.make(forecast: .loading).content == .loading)
        // Blocking problems still show at once.
        #expect(Self.make(forecast: .loading, refreshUnavailable: true).content
            == .blocked(SmartShiftPresentation.refreshFailedMessage))
    }

    @Test func anUnresolvedSolcastSetupIsStillLoading() {
        #expect(LoadTimingForecastPresentation.forecastAvailability(
            .init(state: .basic, connection: .checking, cause: nil, reason: nil,
                  forecastFetchedAt: nil, now: Self.now),
            usesAutomaticForecast: false, automaticStatus: nil) == .loading)
    }
}
