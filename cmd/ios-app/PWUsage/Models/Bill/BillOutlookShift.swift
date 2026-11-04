import Foundation

/// Moving imports out of a gap into a cushion on the same plan, priced exactly as the bill settles.
struct BillOutlookShift: Equatable {
    let cushion: BillOutlookTariff
    let gap: BillOutlookTariff
    let energyKwh: Double
    let savings: Double
}

extension BillOutlook {
    /// Below this, a shift is not worth changing anyone's routine. In the bill's currency.
    private static let minimumShiftSavings = 0.25

    /// The most valuable shift still possible this cycle. Each rate period settles alone, so a kWh
    /// left in a cushion earns its sell rate while a kWh in a gap costs its buy rate. `remaining`
    /// limits this to periods that still occur, since an ended period's cushion cannot be used.
    static func bestShift(projected: BillOutlookPoint, remaining: [BillOutlookTariff]) -> BillOutlookShift? {
        let before = cost(projected.buckets)
        func tariff(for period: BillOutlookPeriod) -> BillOutlookTariff? {
            remaining.last { $0.tariffName == period.tariffName && $0.periodName == period.periodName }
        }
        var shifts: [BillOutlookShift] = []
        for cushionPeriod in projected.periods where cushionPeriod.netGridKwh < 0 {
            for gapPeriod in projected.periods
                where gapPeriod.netGridKwh > 0 && gapPeriod.tariffName == cushionPeriod.tariffName {
                guard let cushion = tariff(for: cushionPeriod), let gap = tariff(for: gapPeriod) else { continue }
                let energyKwh = min(-cushionPeriod.netGridKwh, gapPeriod.netGridKwh)
                let after = cost(projected.buckets + [
                    .init(tariffName: cushion.tariffName, periodName: cushion.periodName, netGridKwh: energyKwh,
                          buyRate: cushion.buyRate, sellRate: cushion.sellRate),
                    .init(tariffName: gap.tariffName, periodName: gap.periodName, netGridKwh: -energyKwh,
                          buyRate: gap.buyRate, sellRate: gap.sellRate)
                ])
                shifts.append(.init(cushion: cushion, gap: gap, energyKwh: energyKwh, savings: before - after))
            }
        }
        return shifts.filter { $0.savings >= minimumShiftSavings }.max { $0.savings < $1.savings }
    }
}
