import Foundation
@testable import PWUsage
import Testing

@Suite("Load Timing Presentation Tests")
struct LoadTimingViewTests {
    @Test("Dashboard summary keeps its active rate and measured balance")
    func dashboardSummaryRetainsObservedDetails() {
        let summary = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Off peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.12, basis: "sell", balanceKwh: 10, energyDataThrough: nil),
            hasTariff: true,
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
            currencyCode: "USD"
        )
        #expect(summary.rate == "48¢/kWh")
        #expect(summary.balance == "No bank yet")
        #expect(!summary.isBanked)
    }

    @Test("Live tariff summary preserves missing tariff and unobserved balance states")
    func dashboardSummaryRetainsUnavailableAndUnobservedStates() {
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: false).message == "No rate plan is set up")
        #expect(DashboardPresentation.loadTimingSummary(nil, hasTariff: true).message == "No live summary is available")
        let owed = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: 0.48, basis: "buy", balanceKwh: -4, energyDataThrough: nil),
            hasTariff: true,
            currencyCode: "USD"
        )
        #expect(owed.balance == "Owed 4.0 kWh")
        #expect(!owed.isBanked)
        let unobservedWithBalance = DashboardPresentation.loadTimingSummary(
            .init(periodName: "Peak", buyRate: 0.48, sellRate: 0.12, marginalCost: nil, basis: "unobserved", balanceKwh: 5, energyDataThrough: nil),
            hasTariff: true
        )
        #expect(unobservedWithBalance.balance == "No bank yet")
        #expect(!unobservedWithBalance.isBanked)
    }

    @Test("Live rate stays hidden until bill currency is known")
    func liveSummaryWaitsForCurrency() {
        let timing = ActiveLoadTiming(periodName: "Peak", buyRate: 0.485, sellRate: 0.12, marginalCost: 0.485, basis: "buy", balanceKwh: 2, energyDataThrough: nil)
        let unlocalized = DashboardPresentation.loadTimingSummary(timing, hasTariff: true)
        #expect(unlocalized.rate == nil)
        #expect(!unlocalized.accessibilityLabel.contains("cents per kilowatt-hour"))
        let localized = DashboardPresentation.loadTimingSummary(timing, hasTariff: true, currencyCode: "USD")
        #expect(localized.rate == "48.5¢/kWh")
        #expect(localized.accessibilityLabel.contains("48.5 cents per kilowatt-hour"))
    }

    @Test("Profile chip title honors edited profile values")
    func profileChipUsesEditedProfile() {
        let edited = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5, durationHours: 2.25, carSettings: nil)
        #expect(LoadTimingPresentation.profileChipTitle(edited) == "Washer · 3.5 kWh")

        let editedCar = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 999, durationHours: 999, carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 10, targetStateOfCharge: 50, chargingLevel: .level1))
        #expect(LoadTimingPresentation.profileChipTitle(editedCar) == "Car · 32 kWh battery")
        #expect(LoadTimingPresentation.profileChipAccessibilityLabel(editedCar).contains("37.6 kilowatt-hours from the wall"))
    }

    @Test("Source time has an explicit label")
    func sourceTimeIsLabelled() {
        let sourceTime = Date(timeIntervalSince1970: 1_800_000_000)
        let summary = LoadTimingPresentation.sourceTimeSummary(sourceTime, timeZone: "UTC")
        #expect(summary.hasPrefix("Energy observations through "))
        #expect(summary.contains("8:00"))
    }

    @Test("A failed refresh without saved response shows recommendation failure without inventing estimates")
    func missingResponseRecommendationExplainsRefreshFailure() {
        let message = LoadTimingPresentation.noResponseRecommendationMessage
        #expect(message.title == "Recommendation unavailable")
        #expect(message.detail.contains("refresh failed"))
        #expect(message.detail.contains("bill data"))
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

    @Test("Forecast notes keep their reason and avoid misleading clock advice")
    func forecastNotesKeepReasonsAccurate() {
        typealias P = LoadTimingForecastPresentation
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(P.forecastUnavailableNote(.noFittingRun) == "This load is longer than the search horizon.")
        #expect(P.forecastUnavailableNote(.incompleteContext)
            == "There is not enough household history yet to estimate expected usage.")
        #expect(P.forecastUnavailableNote(.missingTariff)
            == "An active rate plan is needed before costs can be compared.")

        let malformed = P.forecastAvailability(
            state: .failedWithBasic, connection: .ready, cause: nil, reason: .contextMalformed,
            forecastFetchedAt: nil, now: now
        )
        #expect(malformed == .unusable("The household profile your server sent could not be read by this app version, so start times cannot be compared right now."))
        if case .unusable(let note) = malformed {
            #expect(!note.localizedCaseInsensitiveContains("date and time"))
        }

        #expect(P.forecastAvailability(
            state: .failedWithBasic, connection: .ready, cause: .budgetExhausted, reason: nil,
            forecastFetchedAt: nil, now: now
        ) == .unusable("This device has used its forecast allowance for today."))
        #expect(P.forecastAvailability(
            state: .failedWithBasic, connection: .ready, cause: nil, reason: .timestampMisaligned,
            forecastFetchedAt: nil, now: now
        ) == .unusable("Your energy readings exist, but their timestamps do not line up with this site's local time, so a household profile cannot be built."))

        let future = P.forecastAvailability(
            state: .enhanced, connection: .ready, cause: nil, reason: nil,
            forecastFetchedAt: now.addingTimeInterval(10 * 60), now: now
        )
        #expect(future == .unusable(P.firstSentence(P.futureDatedForecastNote)))
        if case .unusable(let note) = future {
            #expect(!note.contains("too old"))
        }
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
