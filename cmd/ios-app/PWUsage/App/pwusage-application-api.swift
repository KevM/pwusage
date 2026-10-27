@MainActor
protocol PWUsageApplicationAPI: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileAuthAPI {
    func fetchSites() async throws -> [MobileSite]
}

