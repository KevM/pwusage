import SwiftUI

/// The day colors shared by the strip, the banner and the flying dots: grey until sorted, blue
/// for cloudy, amber for clear, and a faint dashed ring for no production.
enum SolarSystemColors {
    static let pending = Color(.systemGray3)
    static let cloudy = Color(.systemBlue)
    static let clear = Color(.systemOrange)
    static let noProduction = Color(.systemGray2)
    static let wedge = Color(.systemOrange)
    static let ring = Color(.systemGray3)
    static let panel = Color(red: 0.13, green: 0.2, blue: 0.36)

    static func color(_ type: SolarDayType?) -> Color {
        switch type {
        case nil: pending
        case .cloudy?: cloudy
        case .clear?: clear
        case .noProduction?: noProduction
        }
    }

    static func name(_ type: SolarDayType?) -> String {
        switch type {
        case nil: "not sorted yet"
        case .cloudy?: "cloudy"
        case .clear?: "clear"
        case .noProduction?: "no production"
        }
    }
}
