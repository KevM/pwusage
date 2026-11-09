// Every retroactive conformance this type has, in one place. Each protocol is
// declared next to the type that consumes it, which is why these used to be one
// line each in three files.
extension PWUsageAPI: MobileDashboardDataAPI, MobileLivePowerDataAPI, MobileConditionalDashboardDataAPI {}
extension PWUsageAPI: MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI, MobileSolarHistoryFillAPI {}
extension PWUsageAPI: MobileBillingDayAPI {}
extension PWUsageAPI: PWUsageApplicationAPI {}

extension PWUsageAPI: MobileTariffDataAPI {}
extension PWUsageAPI: MobileBatteryHoldDataAPI {}
extension PWUsageAPI: BatteryHoldActivityAPI {}
