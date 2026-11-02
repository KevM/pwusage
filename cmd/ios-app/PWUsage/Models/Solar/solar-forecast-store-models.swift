import Foundation

protocol SolarForecastClock: Sendable { func now() -> Date }

struct SystemSolarForecastClock: SolarForecastClock {
    func now() -> Date { Date() }
}
