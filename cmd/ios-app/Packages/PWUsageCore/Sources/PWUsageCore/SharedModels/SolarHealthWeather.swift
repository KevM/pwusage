import Foundation

public struct SolarHealthWeather: Codable, Equatable, Sendable {
    public var rainDays: Set<String>
    public var snowDays: Set<String>

    public init(rainDays: Set<String> = [], snowDays: Set<String> = []) {
        self.rainDays = rainDays
        self.snowDays = snowDays
    }

    public var hasPrecipitation: Bool { !rainDays.isEmpty || !snowDays.isEmpty }

    public mutating func formUnion(_ other: Self) {
        rainDays.formUnion(other.rainDays)
        snowDays.formUnion(other.snowDays)
    }
}
