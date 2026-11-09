@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI,
    MobileBillingDayAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}
