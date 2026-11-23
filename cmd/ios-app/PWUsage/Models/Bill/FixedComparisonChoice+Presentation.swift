import PWUsageCore

extension FixedComparisonChoice {
    /// A display-only reference period for the staged choice over `from...to`, so one row type
    /// renders stored and staged comparisons alike. Never sent: `source` is `.manual`, never
    /// `.estimated`, and `periodId`/`tariffId` are -1. One flat all-day season at `buyRate`.
    func stagedReference(from: String, to: String?) -> TariffPeriodDTO {
        let sell = if case let .manual(_, _, sellRate) = self { sellRate } else { 0.0 }
        let window = TimePeriodWindowInput(
            touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0,
            buyRate: buyRate, sellRate: sell
        )
        let season = TariffSeasonInput(
            name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: -1, tariffId: -1, name: name, version: 0, source: .manual,
            effectiveFrom: from, effectiveTo: to, isCurrentToday: false, updatedBy: nil,
            seasons: [season], urdbLabel: label
        )
    }
}
