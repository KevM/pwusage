import Foundation
@testable import PWUsage
import Testing

extension PWUsageAppModelTests {
    private static func unconfirmedSite(_ id: String) -> MobileSite {
        MobileSite(id: id, name: "Home \(id)", utility: "Utility", billingDay: 1, billingDayConfirmed: false)
    }

    @Test("Saving the billing day posts it and marks the selected site confirmed")
    func savingBillingDayConfirmsSite() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()

        try await model.saveBillingDay(15, siteID: "site-1")

        #expect(api.billingDayCalls.map(\.day) == [15])
        #expect(api.billingDayCalls.map(\.siteID) == ["site-1"])
        let site = try #require(model.sites.first)
        #expect(site.billingDay == 15)
        #expect(site.billingDayConfirmed)
    }

    @Test("A failed save leaves the site unchanged and throws")
    func failedSaveLeavesSiteUnchanged() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        api.billingDayError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        let model = try makeModel(api: api)
        await model.bootstrap()

        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            try await model.saveBillingDay(15, siteID: "site-1")
        }
        #expect(model.sites.first?.billingDay == 1)
        #expect(model.sites.first?.billingDayConfirmed == false)
    }

    @Test("A site outside the account list is never saved to the list")
    func unknownSiteIsNotInserted() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()

        try await model.saveBillingDay(9, siteID: "elsewhere")

        #expect(model.sites.map(\.id) == ["site-1"])
        #expect(model.sites.first?.billingDayConfirmed == false)
    }

    @Test("The demo never saves a billing day and never calls the API")
    func demoNeverSaves() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(), api: api, userDefaults: makeDefaults(), isDemo: true)
        await model.bootstrap()

        await #expect(throws: PWUsageAPIError.self) {
            try await model.saveBillingDay(15, siteID: "site-1")
        }
        #expect(api.billingDayCalls.isEmpty)
        #expect(model.billingDayPromptSite == nil)
    }

    @Test("The prompt is for the selected unconfirmed site and clears once it is saved")
    func promptFollowsSelectedSite() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1"), Self.site("site-2")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        #expect(model.billingDayPromptSite?.id == "site-1")

        try await model.saveBillingDay(15, siteID: "site-1")
        #expect(model.billingDayPromptSite == nil)
    }

    @Test("Not now hides the prompt for that site until the next launch")
    func notNowHidesPromptForTheRun() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        #expect(model.billingDayPromptSite != nil)

        model.dismissBillingDayPrompt()

        #expect(model.billingDayPromptSite == nil)
        #expect(api.billingDayCalls.isEmpty)
        #expect(model.sites.first?.billingDayConfirmed == false)
    }

    @Test("A day chosen on the web clears the prompt when the app comes forward")
    func webConfirmationClearsPrompt() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()
        #expect(model.billingDayPromptSite != nil)

        api.sites = [MobileSite(id: "site-1", name: "Home site-1", utility: "Utility",
                                billingDay: 20, billingDayConfirmed: true)]
        await model.refreshBillingDays()

        #expect(model.billingDayPromptSite == nil)
        #expect(model.sites.first?.billingDay == 20)
    }

    @Test("A failed refresh of the billing days changes nothing")
    func failedRefreshChangesNothing() async throws {
        let api = ApplicationAPISpy(sites: [Self.unconfirmedSite("site-1")])
        let model = try makeModel(api: api)
        await model.bootstrap()

        api.sitesError = URLError(.notConnectedToInternet)
        await model.refreshBillingDays()

        #expect(model.sites == [Self.unconfirmedSite("site-1")])
    }
}
