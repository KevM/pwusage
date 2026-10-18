import Foundation
import Testing
@testable import PWUsage

struct SmartShiftDiagnosticsTests {
    typealias Estimator = LoadTimingForecastEstimator
    typealias Fixtures = SmartShiftPresentationTests

    static let intervals = (0..<96).map { index in
        SolarForecastInterval(periodStart: Fixtures.at(Double(index) / 2), periodEnd: Fixtures.at(Double(index + 1) / 2),
                              powerKw: 1, cautiousPowerKw: index.isMultiple(of: 2) ? 0.4 : nil)
    }

    /// Diagnostics for a real pass, priced as the card prices it.
    static func diagnostics(forecast: ForecastAvailability = .ready, intervals: [SolarForecastInterval]? = intervals,
                            context: Estimator.PlanningContext?,
                            balanceSourceTime: Date? = nil) -> (SmartShiftDiagnostics, SmartShiftEvaluation) {
        let (timing, _, now, car) = Fixtures.harrisonSunday()
        let source = balanceSourceTime ?? now
        let evaluation = SmartShiftPresentation.evaluate(
            profile: car, now: now, timing: timing, forecast: forecast, intervals: intervals, context: context,
            balanceSourceTime: source, billingCycleEnd: Fixtures.at(48), currencyCode: "USD", timeZone: "UTC")
        let diagnostics = SmartShiftDiagnostics(
            siteId: "site-42", app: .init(version: "1.2", build: "34"), job: car, now: now, balanceSourceTime: source,
            billingCycleEnd: Fixtures.at(48), currencyCode: "USD", timeZone: "UTC", timing: timing,
            evaluation: evaluation, intervals: intervals, context: context, forecastFetchedAt: now.addingTimeInterval(-600))
        return (diagnostics, evaluation)
    }

    static func roundTrip(_ diagnostics: SmartShiftDiagnostics) throws -> SmartShiftDiagnostics {
        let json = try diagnostics.json()
        return try SmartShiftDiagnostics.decoder().decode(SmartShiftDiagnostics.self, from: Data(json.utf8))
    }

    @Test func roundTripsTheForecastPassAndItsComparison() throws {
        let (diagnostics, evaluation) = Self.diagnostics(context: Fixtures.historyContext(asOf: Fixtures.at(13)))
        let comparison = try #require(evaluation.result.comparison)
        let decoded = try Self.roundTrip(diagnostics)

        #expect(decoded == diagnostics)
        #expect(decoded.siteId == "site-42")
        #expect(decoded.job.id == "car")
        #expect(decoded.job.carSettings?.capacityKwh == 79.05)
        #expect(decoded.projection == .forecast)
        #expect(decoded.forecastAvailability == .init(.ready))
        #expect(decoded.forecastIntervals?.count == 96)
        #expect(decoded.forecastIntervals?.first?.cautiousPowerKw == 0.4)
        #expect(decoded.forecastIntervals?[1].cautiousPowerKw == nil)
        #expect(decoded.planningContext?.slots.first { $0.localMinute == 480 }?.gridNetExportKw == 2)
        #expect(decoded.planningContext?.slots.first { $0.localMinute == 480 }?.cautiousGridNetExportKw == 1)
        #expect(decoded.loadTiming.tariffTimeline.count == 3)
        #expect(decoded.loadTiming.pricingPeriods.map(\.cycleNetExportKwh) == [-64, 5])

        let record = try #require(decoded.result.comparison)
        #expect(record == comparison)
        #expect(record.recommendedStart == comparison.recommendedStart)
        #expect(record.savings == comparison.savings)
        #expect(record.projectionEnd == comparison.projectionEnd)
        #expect(record.safetyEnd == comparison.safetyEnd)
        #expect(record.lanes.map(\.projectedAfterRecommendedKwh) == comparison.lanes.map(\.projectedAfterRecommendedKwh))
    }

    @Test func replaysTheRecordedInputsToTheSameResult() throws {
        let (diagnostics, evaluation) = Self.diagnostics(context: Fixtures.historyContext(asOf: Fixtures.at(13)))
        let decoded = try Self.roundTrip(diagnostics)
        #expect(decoded.replay() == evaluation.result)
    }

    @Test func recordsTheHistoryFallbackAndWhyTheForecastWasSkipped() throws {
        // A balance more than 30 minutes old rules out the forecast; grid history still prices the run.
        let (_, _, now, _) = Fixtures.harrisonSunday()
        let (diagnostics, evaluation) = Self.diagnostics(context: Fixtures.historyContext(asOf: now),
                                                         balanceSourceTime: now.addingTimeInterval(-45 * 60))
        let decoded = try Self.roundTrip(diagnostics)
        #expect(decoded.projection == .history)
        #expect(decoded.forecastAvailability.state == "unusable")
        #expect(decoded.forecastAvailability.note?.isEmpty == false)
        #expect(decoded.result.comparison?.usesHistory == true)
        #expect(decoded.replay() == evaluation.result)
    }

    @Test func recordsAnUnavailableFlatPass() throws {
        var (timing, _, now, car) = Fixtures.harrisonSunday()
        timing = LoadTiming(hasTariff: false, hasCycleData: true, activeIsCheapest: false, periods: timing.periods,
                            pricingPeriods: timing.pricingPeriods, tariffTimeline: timing.tariffTimeline, nextCheaper: nil,
                            nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let evaluation = SmartShiftPresentation.evaluate(
            profile: car, now: now, timing: timing, forecast: .none, intervals: nil, context: nil,
            balanceSourceTime: now, billingCycleEnd: Fixtures.at(48), currencyCode: "USD", timeZone: "UTC")
        let diagnostics = SmartShiftDiagnostics(
            siteId: "site-42", app: nil, job: car, now: now, balanceSourceTime: now, billingCycleEnd: Fixtures.at(48),
            currencyCode: "USD", timeZone: "UTC", timing: timing, evaluation: evaluation, intervals: nil, context: nil,
            forecastFetchedAt: nil)
        let decoded = try Self.roundTrip(diagnostics)
        #expect(decoded.projection == .flat)
        #expect(decoded.forecastAvailability.state == "none")
        #expect(decoded.result.comparison == nil)
        #expect(decoded.result.unavailableReason == .missingTariff)
        #expect(decoded.replay() == evaluation.result)
    }

    @Test func writesUTCDatesAndTheSiteTimeZone() throws {
        let (diagnostics, _) = Self.diagnostics(context: Fixtures.historyContext(asOf: Fixtures.at(13)))
        let object = try #require(try JSONSerialization.jsonObject(with: Data(diagnostics.json().utf8)) as? [String: Any])
        let now = try #require(object["now"] as? String)
        #expect(now.hasSuffix("Z"))
        #expect(ISO8601DateFormatter().date(from: now.replacingOccurrences(of: ".000", with: "")) == Fixtures.at(13.2))
        #expect(object["timeZone"] as? String == "UTC")
        #expect(object["schemaVersion"] as? Int == SmartShiftDiagnostics.currentSchemaVersion)
    }

    @Test func carriesNoCredentialFields() throws {
        let (diagnostics, _) = Self.diagnostics(context: Fixtures.historyContext(asOf: Fixtures.at(13)))
        let object = try JSONSerialization.jsonObject(with: Data(diagnostics.json().utf8))
        var keys: Set<String> = []
        func collect(_ value: Any) {
            if let dictionary = value as? [String: Any] {
                for (key, child) in dictionary {
                    keys.insert(key.lowercased())
                    collect(child)
                }
            } else if let array = value as? [Any] {
                array.forEach(collect)
            }
        }
        collect(object)
        #expect(keys.contains("siteid"))
        let forbidden = ["apikey", "api_key", "token", "secret", "cookie", "password", "resource", "authorization", "credential"]
        let leaks = keys.filter { key in forbidden.contains { key.contains($0) } }
        #expect(leaks.isEmpty, "Credential-like keys in diagnostics: \(leaks.sorted())")
    }
}
