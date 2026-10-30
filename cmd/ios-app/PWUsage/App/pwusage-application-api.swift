@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarLayoutDataAPI,
    MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}
