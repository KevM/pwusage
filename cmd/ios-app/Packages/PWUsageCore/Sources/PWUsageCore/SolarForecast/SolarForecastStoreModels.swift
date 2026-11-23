import Foundation

public protocol SolarForecastClock: Sendable { func now() -> Date }

public struct SystemSolarForecastClock: SolarForecastClock {
    public init() {}
    public func now() -> Date { Date() }
}
