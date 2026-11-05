import Foundation

/// One way to lower the bill: use energy in `destination` rather than `source`. Every view reads
/// this shape, so another kind of saving only needs a new `Role` and a way to build the move.
struct BillSavingsMove: Equatable {
    enum Role: Equatable {
        case pay, onlyEarn

        var caption: String {
            switch self {
            case .pay: "you pay"
            case .onlyEarn: "you'd only earn"
            }
        }
    }

    struct Side: Equatable {
        let periodName: String
        let rate: Double
        let role: Role

        var title: String { DashboardPresentation.tariffPeriodTitle(periodName) }
    }

    let source: Side
    let destination: Side
    let energyKwh: Double
    let savings: Double

    var headline: String { "Run heavy energy use in \(destination.title)" }
    var energyText: String { DashboardPresentation.energy(energyKwh) }

    func amount(currency: String, locale: Locale = .current) -> String {
        "about \(DashboardPresentation.currency(savings, code: currency, locale: locale))"
    }
    func rowHeadline(currency: String, locale: Locale = .current) -> String {
        "Could save \(amount(currency: currency, locale: locale))"
    }
    func rateText(for side: Side, currency: String, locale: Locale = .current) -> String {
        DashboardPresentation.loadRate(side.rate, code: currency, locale: locale)
            .replacingOccurrences(of: "/kWh", with: "")
    }
    func accessibilityLabel(currency: String, locale: Locale = .current) -> String {
        let sourceRate = DashboardPresentation.loadRate(source.rate, code: currency, locale: locale)
        let destinationRate = DashboardPresentation.loadRate(destination.rate, code: currency, locale: locale)
        return "Moving about \(energyText) of use from \(source.title), where \(source.role.caption) \(sourceRate), "
            + "to \(destination.title), where \(destination.role.caption) \(destinationRate)."
    }

    /// A gap's imports cost its buy rate; a cushion's spare kWh only earn its sell rate.
    static func make(from shift: BillOutlookShift) -> BillSavingsMove {
        BillSavingsMove(
            source: Side(periodName: shift.gap.periodName, rate: shift.gap.buyRate, role: .pay),
            destination: Side(periodName: shift.cushion.periodName, rate: abs(shift.cushion.sellRate),
                              role: .onlyEarn),
            energyKwh: shift.energyKwh,
            savings: shift.savings
        )
    }
}
