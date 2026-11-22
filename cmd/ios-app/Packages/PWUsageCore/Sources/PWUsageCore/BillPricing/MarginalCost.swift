import Foundation

enum MarginalCostBasis: String, Equatable, Sendable {
    case sell
    case buy
    case neutral
}

struct MarginalCostResult: Equatable, Sendable {
    let cycleNetExportKwh: Double
    let marginalCost: Double?
    let basis: MarginalCostBasis
}

enum MarginalCost {
    static let defaultEpsilonKwh = 0.1

    static func compute(
        gridWh: Double,
        buyRate: Double,
        sellRate: Double,
        epsilonKwh: Double = defaultEpsilonKwh
    ) -> MarginalCostResult {
        // UsageData.gridUsage is positive when importing, negative when exporting.
        // Negate to get an export-positive value.
        let cycleNetExportKwh = -(gridWh / 1000.0)
        if abs(cycleNetExportKwh) < epsilonKwh {
            return MarginalCostResult(
                cycleNetExportKwh: cycleNetExportKwh,
                marginalCost: buyRate,
                basis: .neutral
            )
        }
        if cycleNetExportKwh > 0 {
            return MarginalCostResult(
                cycleNetExportKwh: cycleNetExportKwh,
                marginalCost: sellRate,
                basis: .sell
            )
        }
        return MarginalCostResult(
            cycleNetExportKwh: cycleNetExportKwh,
            marginalCost: buyRate,
            basis: .buy
        )
    }
}
