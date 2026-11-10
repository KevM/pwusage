@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI,
    MobileBillingDayAPI, MobileTrmnlAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}
