import Foundation

/// Canonical daily tariff/TOU netted amounts, calculated by the server.
public struct TodayEnergyCost: Codable, Equatable, Sendable {
    public var netCost: Double
    public var importCharges: Double
    public var exportCredits: Double
    public var currency: String

    public init(netCost: Double, importCharges: Double, exportCredits: Double, currency: String) {
        self.netCost = netCost
        self.importCharges = importCharges
        self.exportCredits = exportCredits
        self.currency = currency
    }

    public var isValid: Bool {
        [netCost, importCharges, exportCredits].allSatisfy(\.isFinite)
            && importCharges >= 0 && exportCredits >= 0
            && abs(netCost - (importCharges - exportCredits)) < 0.000001
            && currency.count == 3 && currency.utf8.allSatisfy { (65 ... 90).contains($0) }
    }
}
