import Foundation

public struct EnergyFlowDay: Equatable, Sendable {
    public let day: String
    public let dayStart: Date
    public let solarWh: [Float?]
    public let loadWh: [Float?]
    public let gridWh: [Float?]
    public let batteryWh: [Float?]
    public let batterySoc: [Float?]

    public init(
        day: String,
        dayStart: Date,
        solarWh: [Float?],
        loadWh: [Float?],
        gridWh: [Float?],
        batteryWh: [Float?],
        batterySoc: [Float?]
    ) {
        self.day = day
        self.dayStart = dayStart
        self.solarWh = solarWh
        self.loadWh = loadWh
        self.gridWh = gridWh
        self.batteryWh = batteryWh
        self.batterySoc = batterySoc
    }
}
