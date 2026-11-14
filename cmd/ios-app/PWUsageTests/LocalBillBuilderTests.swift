import Foundation
@testable import PWUsage
import Testing

@Suite("LocalBillBuilder")
struct LocalBillBuilderTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "test-account", siteID: "site-1")

    private func makeTempStore() -> (store: SolarHistoryStore, folder: URL) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-bill-builder-\(UUID().uuidString)")
        return (SolarHistoryStore(directory: folder), folder)
    }

    private func seedStore(
        _ store: SolarHistoryStore,
        fixture: BillPricingFixture
    ) async throws {
        let timeZone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        let historyDays = fixture.days.map { day in
            let slotCount = day.gridWh.count
            return MobileSolarHistoryDay(
                day: day.day,
                dayStart: day.dayStart,
                status: .complete,
                fetchedAt: day.dayStart,
                solarWh: day.solarWh.map { $0.map(Double.init) },
                loadWh: day.loadWh.map { $0.map(Double.init) },
                gridWh: day.gridWh.map { $0.map(Double.init) },
                batteryWh: Array(repeating: Double?(0), count: slotCount),
                batterySoc: Array(repeating: Double?.none, count: slotCount)
            )
        }
        let fill = MobileSolarHistoryFill(
            timeZone: timeZone,
            status: .complete,
            historyStart: historyDays.first?.day ?? "2026-01-01",
            days: historyDays
        )
        try await store.merge(fill, scope: scope)
    }

    @Test("Builds ready response matching fixture")
    func buildsReadyResponseMatchingFixture() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        try await seedStore(store, fixture: fixture)

        let site = MobileBillResponse.Site(
            id: fixture.timeline.siteId,
            name: "Home",
            timezone: fixture.timeline.timezone
        )
        let builder = LocalBillBuilder(store: store)
        let result = try await builder.build(
            site: site,
            billingDay: fixture.billingDay,
            timeline: fixture.timeline,
            scope: scope,
            now: fixture.now
        )

        guard case .ready(let response) = result else {
            Issue.record("Expected .ready, got \(result)")
            return
        }
        try assertReadyResponse(response, matches: fixture, site: site)
    }

    private func assertReadyResponse(
        _ response: MobileBillResponse,
        matches fixture: BillPricingFixture,
        site: MobileBillResponse.Site
    ) throws {
        #expect(response.version == 1)
        #expect(response.revision == nil)
        #expect(response.site == site)
        #expect(response.tariffReattribution == fixture.timeline.reattribution)
        #expect(response.sources.calculatedAt == fixture.now)
        #expect(response.currentBill.currency == fixture.timeline.currency)
        #expect(response.currentBill.cycleStart == fixture.expected.currentBill.cycleStart)
        #expect(response.currentBill.cycleEnd == fixture.expected.currentBill.cycleEnd)

        let expectedCost = try #require(fixture.expected.currentBill.estimatedCost)
        let actualCost = try #require(response.currentBill.estimatedCost)
        #expect(abs(actualCost - expectedCost) <= 1e-9)

        #expect(response.currentBill.periods.count == fixture.expected.currentBill.periods.count)
        for expectedPeriod in fixture.expected.currentBill.periods {
            let actualPeriod = try #require(response.currentBill.periods.first {
                $0.tariffName == expectedPeriod.tariffName && $0.periodName == expectedPeriod.periodName
            })
            #expect(abs(actualPeriod.netGridKwh - expectedPeriod.netGridKwh) <= 1e-9)
            #expect(abs(actualPeriod.cost - expectedPeriod.cost) <= 1e-9)
        }

        let expectedOutlook = try #require(fixture.expected.outlook)
        let actualOutlook = try #require(response.outlook)
        #expect(actualOutlook.observedThrough == expectedOutlook.observedThrough)
        #expect(actualOutlook.complete == expectedOutlook.complete)
        #expect(actualOutlook.points.count == expectedOutlook.points.count)
        #expect(response.sources.energyDataThrough == expectedOutlook.observedThrough.addingTimeInterval(-300))

        let expectedLoadTiming = try #require(fixture.expected.loadTiming)
        let actualLoadTiming = try #require(response.loadTiming)
        #expect(actualLoadTiming.hasTariff == expectedLoadTiming.hasTariff)
        #expect(actualLoadTiming.hasCycleData == expectedLoadTiming.hasCycleData)
        #expect(actualLoadTiming.activeIsCheapest == expectedLoadTiming.activeIsCheapest)
        #expect(actualLoadTiming.periods.count == expectedLoadTiming.periods.count)
        #expect(actualLoadTiming.pricingPeriods.count == expectedLoadTiming.pricingPeriods.count)
        #expect(actualLoadTiming.nextCheaper?.name == expectedLoadTiming.nextCheaper?.name)
        #expect(actualLoadTiming.tariffTimeline.count == expectedLoadTiming.tariffTimeline.count)
    }

    @Test("Returns notReady(.flowsMissing) when current cycle lacks flows")
    func notReadyWhenCurrentCycleLacksFlows() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-bill-builder-legacy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let firstDay = try #require(fixture.days.first)
        try writeLegacyStore(
            folder: folder,
            dayStart: firstDay.dayStart,
            timeZoneIdentifier: fixture.timeline.timezone
        )
        let store = SolarHistoryStore(directory: folder)

        let site = MobileBillResponse.Site(
            id: fixture.timeline.siteId,
            name: "Home",
            timezone: fixture.timeline.timezone
        )
        let builder = LocalBillBuilder(store: store)
        let result = try await builder.build(
            site: site,
            billingDay: fixture.billingDay,
            timeline: fixture.timeline,
            scope: scope,
            now: fixture.now
        )
        #expect(result == .notReady(.flowsMissing))
    }

    private func writeLegacyStore(
        folder: URL,
        dayStart: Date,
        timeZoneIdentifier: String
    ) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let daysFolder = folder.appendingPathComponent("\(scope.storageHash)-days", isDirectory: true)
        try fileManager.createDirectory(at: daysFolder, withIntermediateDirectories: true)

        var stateData = Data()
        for _ in 0 ..< 288 {
            var bits = Float(10).bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { stateData.append(contentsOf: $0) }
        }
        let yearPayload: [String: Any] = [
            "year": 2026,
            "dayStarts": [dayStart.timeIntervalSinceReferenceDate],
            "counts": [288],
            "slots": stateData.base64EncodedString()
        ]
        try JSONSerialization.data(withJSONObject: yearPayload)
            .write(to: daysFolder.appendingPathComponent("2026.json"))

        let sitePayload: [String: Any] = [
            "timeZone": timeZoneIdentifier,
            "isEnabled": true
        ]
        try JSONSerialization.data(withJSONObject: sitePayload)
            .write(to: folder.appendingPathComponent("\(scope.storageHash).json"))
    }

    @Test("Returns notReady(.noTimeline) when timeline is nil")
    func notReadyWithoutTimeline() async throws {
        let (store, folder) = makeTempStore()
        defer { try? FileManager.default.removeItem(at: folder) }

        let site = MobileBillResponse.Site(id: "site-1", name: "Home", timezone: "UTC")
        let builder = LocalBillBuilder(store: store)
        let result = try await builder.build(
            site: site,
            billingDay: 1,
            timeline: nil,
            scope: scope,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        #expect(result == .notReady(.noTimeline))
    }

    @Test("Timeline fingerprint changes when a rate changes")
    func fingerprintChangesWhenARateChanges() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let baseline = LocalBillBuilder.timelineFingerprint(fixture.timeline)
        #expect(baseline == LocalBillBuilder.timelineFingerprint(fixture.timeline))

        let firstPeriod = try #require(fixture.timeline.periods.first)
        let firstSeason = try #require(firstPeriod.seasons.first)
        let firstWindow = try #require(firstSeason.weekdayPeriods.first)
        let updatedWindow = TimePeriodWindowInput(
            touName: firstWindow.touName,
            fromHour: firstWindow.fromHour,
            fromMinute: firstWindow.fromMinute,
            toHour: firstWindow.toHour,
            toMinute: firstWindow.toMinute,
            buyRate: firstWindow.buyRate + 0.01,
            sellRate: firstWindow.sellRate
        )
        let updatedSeason = TariffSeasonInput(
            name: firstSeason.name,
            fromMonth: firstSeason.fromMonth,
            toMonth: firstSeason.toMonth,
            weekdayPeriods: [updatedWindow] + Array(firstSeason.weekdayPeriods.dropFirst()),
            weekendPeriods: firstSeason.weekendPeriods,
            fromDay: firstSeason.fromDay,
            toDay: firstSeason.toDay
        )
        let updatedPeriod = TariffPeriodDTO(
            periodId: firstPeriod.periodId,
            tariffId: firstPeriod.tariffId,
            name: firstPeriod.name,
            version: firstPeriod.version,
            source: firstPeriod.source,
            effectiveFrom: firstPeriod.effectiveFrom,
            effectiveTo: firstPeriod.effectiveTo,
            isCurrentToday: firstPeriod.isCurrentToday,
            updatedBy: firstPeriod.updatedBy,
            seasons: [updatedSeason] + Array(firstPeriod.seasons.dropFirst())
        )
        let updatedTimeline = SiteTariffsTimelineResponse(
            version: fixture.timeline.version,
            siteId: fixture.timeline.siteId,
            timezone: fixture.timeline.timezone,
            currency: fixture.timeline.currency,
            periods: [updatedPeriod] + Array(fixture.timeline.periods.dropFirst()),
            reattribution: fixture.timeline.reattribution,
            holidayDates: fixture.timeline.holidayDates,
            teslaSync: fixture.timeline.teslaSync
        )
        let changed = LocalBillBuilder.timelineFingerprint(updatedTimeline)
        #expect(changed != baseline)
    }
}
