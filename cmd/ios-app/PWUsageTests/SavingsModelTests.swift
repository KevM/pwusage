import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Savings Model")
struct SavingsModelTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "test-account", siteID: "site-1")

    @Test("Missing reference plan yields notReady(.noReferencePlan)")
    func noReferencePlanIsNotReady() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        try await seedDay(store, day: "2026-06-01")

        let model = SavingsModel(store: store)
        let timeline = makeTimeline(referenceBuyRate: nil)
        let state = await model.refresh(
            scope: scope,
            timeline: timeline,
            billingDay: 1,
            now: makeUTCDate(year: 2026, month: 6, day: 10)
        )
        #expect(state == .notReady(.noReferencePlan))
    }

    @Test("Computes only once per timeline fingerprint and flow signature")
    func computesOncePerFingerprint() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        try await seedDay(store, day: "2026-06-01")

        let counter = ComputeCounter()
        let model = SavingsModel(store: store) { scenarios, actual, reference, billingDay, now in
            counter.compute(
                scenarios: scenarios,
                actual: actual,
                reference: reference,
                billingDay: billingDay,
                now: now
            )
        }
        let timeline = makeTimeline(referenceBuyRate: 0.14)
        let now = makeUTCDate(year: 2026, month: 6, day: 10)

        let first = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)
        let second = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)

        #expect(counter.count == 1)
        #expect(first == second)
        if case .ready = first {} else {
            Issue.record("Expected ready state")
        }
    }

    @Test("Recomputes when reference plan changes")
    func recomputesWhenReferencePlanChanges() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        try await seedDay(store, day: "2026-06-01")

        let counter = ComputeCounter()
        let model = SavingsModel(store: store) { scenarios, actual, reference, billingDay, now in
            counter.compute(
                scenarios: scenarios,
                actual: actual,
                reference: reference,
                billingDay: billingDay,
                now: now
            )
        }
        let now = makeUTCDate(year: 2026, month: 6, day: 10)

        _ = await model.refresh(scope: scope, timeline: makeTimeline(referenceBuyRate: 0.14), billingDay: 1, now: now)
        _ = await model.refresh(scope: scope, timeline: makeTimeline(referenceBuyRate: 0.18), billingDay: 1, now: now)

        #expect(counter.count == 2)
    }

    @Test("Recomputes when a new day arrives in stored flows")
    func recomputesWhenNewDayArrives() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        try await seedDay(store, day: "2026-06-01")

        let counter = ComputeCounter()
        let model = SavingsModel(store: store) { scenarios, actual, reference, billingDay, now in
            counter.compute(
                scenarios: scenarios,
                actual: actual,
                reference: reference,
                billingDay: billingDay,
                now: now
            )
        }
        let timeline = makeTimeline(referenceBuyRate: 0.14)
        let now = makeUTCDate(year: 2026, month: 6, day: 10)

        _ = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)
        try await seedDay(store, day: "2026-06-02")
        _ = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)

        #expect(counter.count == 2)
    }

    @Test("Recomputes when an existing day sample changes")
    func recomputesWhenExistingDayChanges() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }
        try await seedDay(store, day: "2026-06-01", solarWh: 1_000)

        let counter = ComputeCounter()
        let model = SavingsModel(store: store) { scenarios, actual, reference, billingDay, now in
            counter.compute(
                scenarios: scenarios,
                actual: actual,
                reference: reference,
                billingDay: billingDay,
                now: now
            )
        }
        let timeline = makeTimeline(referenceBuyRate: 0.14)
        let now = makeUTCDate(year: 2026, month: 6, day: 10)

        _ = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)
        try await seedDay(store, day: "2026-06-01", solarWh: 1_500)
        _ = await model.refresh(scope: scope, timeline: timeline, billingDay: 1, now: now)

        #expect(counter.count == 2)
    }

    private func makeTempStore() -> (store: SolarHistoryStore, folder: URL) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("savings-model-\(UUID().uuidString)")
        return (SolarHistoryStore(directory: folder), folder)
    }

    private func seedDay(_ store: SolarHistoryStore, day: String, solarWh: Double = 1_000) async throws {
        let zone = try #require(TimeZone(identifier: "UTC"))
        let parts = day.split(separator: "-").compactMap { Int($0) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let dayStart = try #require(cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])))
        let entry = MobileSolarHistoryDay(
            day: day,
            dayStart: dayStart,
            status: .complete,
            fetchedAt: dayStart,
            solarWh: [solarWh],
            loadWh: [500],
            gridWh: [-500],
            batteryWh: [0],
            batterySoc: [nil]
        )
        try await store.merge(
            MobileSolarHistoryFill(timeZone: zone, status: .complete, historyStart: day, days: [entry]),
            scope: scope
        )
    }

    private func makeUTCDate(year: Int, month: Int, day: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return cal.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) ?? .now
    }

    private func makeTimeline(referenceBuyRate: Double?) -> SiteTariffsTimelineResponse {
        let actual = makeFlatPeriod(id: 1, name: "Actual", buyRate: 0.30, sellRate: 0.05)
        let ref: [TariffPeriodDTO] = referenceBuyRate.map {
            [makeFlatPeriod(id: 2, name: "Fixed", buyRate: $0, sellRate: 0.04)]
        } ?? []
        return SiteTariffsTimelineResponse(
            version: 2,
            siteId: "site-1",
            timezone: "UTC",
            currency: "USD",
            periods: [actual],
            referencePeriods: ref,
            battery: nil,
            reattribution: nil,
            holidayDates: [],
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil,
                latestTariffName: nil,
                latestUpdatedAt: nil,
                activeManualUpdatedAt: nil,
                differsFromActiveManual: false
            )
        )
    }

    private func makeFlatPeriod(
        id: Int,
        name: String,
        buyRate: Double,
        sellRate: Double
    ) -> TariffPeriodDTO {
        let window = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: buyRate,
            sellRate: sellRate
        )
        let season = TariffSeasonInput(
            name: "All Year",
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [window],
            weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: id,
            tariffId: id * 10,
            name: name,
            version: 1,
            source: .manual,
            effectiveFrom: "2020-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [season]
        )
    }
}

private final class ComputeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0

    var count: Int {
        lock.withLock { _count }
    }

    func compute(
        scenarios: SavingsScenarioDays,
        actual: RatePeriodResolver,
        reference: RatePeriodResolver,
        billingDay: Int,
        now: Date
    ) -> SavingsReport {
        lock.withLock { _count += 1 }
        return SavingsCalculator.compute(
            scenarios: scenarios,
            actual: actual,
            reference: reference,
            billingDay: billingDay,
            now: now
        )
    }
}
