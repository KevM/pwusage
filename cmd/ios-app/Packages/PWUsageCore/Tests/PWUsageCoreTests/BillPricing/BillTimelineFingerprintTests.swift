@testable import PWUsageCore
import Testing

@Suite("Bill timeline fingerprint")
struct BillTimelineFingerprintTests {
    @Test("Timeline fingerprint changes when a rate changes")
    func fingerprintChangesWhenARateChanges() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let baseline = BillPricing.timelineFingerprint(fixture.timeline)
        #expect(baseline == BillPricing.timelineFingerprint(fixture.timeline))

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
        let changed = BillPricing.timelineFingerprint(updatedTimeline)
        #expect(changed != baseline)
    }

    @Test("timelineFingerprint changes when reference plan or battery changes")
    func fingerprintChangesWhenReferencePlanChanges() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let baseline = BillPricing.timelineFingerprint(fixture.timeline)
        let refWindow = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: 0.14,
            sellRate: 0.04
        )
        let refSeason = TariffSeasonInput(
            name: "All Year",
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [refWindow],
            weekendPeriods: [refWindow]
        )
        let refPeriod = TariffPeriodDTO(
            periodId: 99,
            tariffId: 990,
            name: "Fixed",
            version: 1,
            source: .manual,
            effectiveFrom: "2024-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [refSeason]
        )
        let withRef = SiteTariffsTimelineResponse(
            version: fixture.timeline.version,
            siteId: fixture.timeline.siteId,
            timezone: fixture.timeline.timezone,
            currency: fixture.timeline.currency,
            periods: fixture.timeline.periods,
            referencePeriods: [refPeriod],
            battery: SiteBatteryDTO(nameplateEnergyWh: 13_500, nameplatePowerW: 5_000, backupReservePercent: 20),
            reattribution: fixture.timeline.reattribution,
            holidayDates: fixture.timeline.holidayDates,
            teslaSync: fixture.timeline.teslaSync
        )
        #expect(BillPricing.timelineFingerprint(withRef) != baseline)
    }

    @Test("timelineFingerprint changes when system costs change")
    func fingerprintChangesWhenSystemCostsChange() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let baseline = BillPricing.timelineFingerprint(fixture.timeline)
        let withCosts = SiteTariffsTimelineResponse(
            version: fixture.timeline.version,
            siteId: fixture.timeline.siteId,
            timezone: fixture.timeline.timezone,
            currency: fixture.timeline.currency,
            periods: fixture.timeline.periods,
            referencePeriods: fixture.timeline.referencePeriods,
            battery: fixture.timeline.battery,
            reattribution: fixture.timeline.reattribution,
            holidayDates: fixture.timeline.holidayDates,
            teslaSync: fixture.timeline.teslaSync,
            systemCosts: SystemCostsDTO(
                siteInstalled: "2026-06-10",
                solar: SystemCostDTO(installDate: nil, price: 16_100, taxCreditPercent: 30, incentives: 0),
                powerwall: nil
            )
        )
        #expect(BillPricing.timelineFingerprint(withCosts) != baseline)
    }
}
