import Foundation
@testable import PWUsage
import Testing

@Suite("System costs draft")
struct SystemCostsDraftTests {
    private static let utc = TimeZone(secondsFromGMT: 0) ?? .gmt

    private static func costs(
        siteInstalled: String = "2023-11-14",
        solar: SystemCostDTO? = nil,
        powerwall: SystemCostDTO? = nil
    ) -> SystemCostsDTO {
        SystemCostsDTO(siteInstalled: siteInstalled, solar: solar, powerwall: powerwall)
    }

    @Test("A new draft prefills the site install day and the Powerwall battery start")
    func draftPrefillsSiteInstallAndBatteryStart() {
        let draft = SystemCostsDraft(
            costs: Self.costs(siteInstalled: "2023-11-14"),
            batteryStartDay: "2024-03-04",
            hasPowerwall: true,
            timeZone: Self.utc
        )
        #expect(draft.solar.installDay == "2023-11-14")
        #expect(draft.powerwall.installDay == "2024-03-04")
    }

    @Test("The tax credit pre-fills from the install year and ends from 2026")
    func draftPrefillsCreditFromInstallYear() {
        func credit(installed: String) -> Double? {
            SystemCostsDraft(
                costs: Self.costs(siteInstalled: installed), batteryStartDay: nil, hasPowerwall: false,
                timeZone: Self.utc
            ).solar.taxCreditPercent
        }
        #expect(credit(installed: "2019-06-01") == 30)
        #expect(credit(installed: "2021-06-01") == 26)
        #expect(credit(installed: "2023-11-14") == 30)
        #expect(credit(installed: "2026-02-01") == nil)
    }

    @Test("An edited credit survives an install date change")
    func editedCreditSurvivesDateChange() {
        var draft = SystemCostsDraft(
            costs: Self.costs(siteInstalled: "2023-11-14"), batteryStartDay: nil, hasPowerwall: false,
            timeZone: Self.utc
        )
        draft.solar.setTaxCredit(20)
        draft.solar.setInstallDay("2019-05-01")
        #expect(draft.solar.taxCreditPercent == 20)

        draft.solar.setInstallDay("2021-05-01")
        #expect(draft.solar.taxCreditPercent == 20)
    }

    @Test("An untouched credit follows an install date change")
    func untouchedCreditFollowsDateChange() {
        var draft = SystemCostsDraft(
            costs: Self.costs(siteInstalled: "2023-11-14"), batteryStartDay: nil, hasPowerwall: false,
            timeZone: Self.utc
        )
        draft.solar.setInstallDay("2021-05-01")
        #expect(draft.solar.taxCreditPercent == 26)
    }

    @Test("Incentives above the price block the request")
    func draftRejectsIncentivesAbovePrice() {
        var draft = SystemCostsDraft(
            costs: Self.costs(), batteryStartDay: nil, hasPowerwall: false, timeZone: Self.utc
        )
        draft.solar.price = 1_000
        draft.solar.incentives = 1_500
        #expect(draft.request == nil)
        #expect(draft.validationMessage != nil)

        draft.solar.incentives = 1_000
        #expect(draft.request?.solar?.incentives == 1_000)
        #expect(draft.validationMessage == nil)
    }

    @Test("Without a battery the form has no Powerwall, even with a price typed")
    func formOmitsPowerwallWithoutBattery() {
        var draft = SystemCostsDraft(
            costs: Self.costs(), batteryStartDay: nil, hasPowerwall: false, timeZone: Self.utc
        )
        draft.powerwall.price = 9_000
        draft.powerwall.installDay = "2024-03-04"
        #expect(draft.powerwallNetCost == nil)
        #expect(draft.request?.powerwall == nil)
        #expect(draft.validationMessage == nil)
    }

    @Test("A cleared component is sent as an explicit null")
    func draftBuildsRequestWithNullForRemovedComponent() {
        var draft = SystemCostsDraft(
            costs: Self.costs(
                solar: SystemCostDTO(installDate: nil, price: 24_000, taxCreditPercent: 30, incentives: 1_000),
                powerwall: SystemCostDTO(installDate: "2024-03-04", price: 14_500, taxCreditPercent: 30, incentives: 0)
            ),
            batteryStartDay: nil,
            hasPowerwall: true,
            timeZone: Self.utc
        )
        #expect(draft.solarNetCost.map { abs($0 - 16_100) < 0.001 } == true)

        draft.solar.price = nil
        let request = draft.request
        #expect(request?.solar == nil)
        #expect(request?.powerwall == SystemCostDTO(
            installDate: "2024-03-04", price: 14_500, taxCreditPercent: 30, incentives: 0
        ))
    }

    @Test("A Powerwall price without a battery start needs an install date")
    func draftRequiresPowerwallDateWithoutBatteryStart() {
        var draft = SystemCostsDraft(
            costs: Self.costs(), batteryStartDay: nil, hasPowerwall: true, timeZone: Self.utc
        )
        draft.powerwall.price = 9_000
        #expect(draft.request == nil)
        #expect(draft.validationMessage != nil)

        draft.powerwall.setInstallDay("2024-03-04")
        #expect(draft.request?.powerwall?.installDate == "2024-03-04")
        #expect(draft.validationMessage == nil)
    }
}
