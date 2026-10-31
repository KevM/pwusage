@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI,
    MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}
