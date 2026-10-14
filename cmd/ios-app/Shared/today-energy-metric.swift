import Foundation

enum TodayEnergyMetric: String, CaseIterable, Codable, Sendable {
    case home, solar, grid, battery

    var index: Int {
        switch self {
        case .home: 0
        case .solar: 1
        case .grid: 2
        case .battery: 3
        }
    }

    var title: String { rawValue.capitalized }
}
