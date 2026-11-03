import SwiftUI

/// The prototypes' colors, shared by the strip, the banner and the flying dots: grey until sorted,
/// blue for cloudy, amber for clear, and a faint dashed ring for no production.
enum SolarSystemColors {
    static let pending = Color.primary.opacity(0.18)
    static let cloudy = Color(red: 0x85 / 255, green: 0xB7 / 255, blue: 0xEB / 255)
    static let clear = Color(red: 0xEF / 255, green: 0x9F / 255, blue: 0x27 / 255)
    static let noProduction = Color(red: 0xB4 / 255, green: 0xB2 / 255, blue: 0xA9 / 255)
    static let wedge = clear
    /// The fitted direction and the landed rays.
    static let ray = Color(red: 0xBA / 255, green: 0x75 / 255, blue: 0x17 / 255)
    static let ring = Color.primary.opacity(0.18)
    static let disk = Color(.systemGroupedBackground)
    static let shadow = Color(red: 136 / 255, green: 135 / 255, blue: 128 / 255).opacity(0.2)
    static let panelEdge = cloudy

    /// Base colors the sun shades, as RGB.
    static let wall = SIMD3<Double>(214, 211, 199)
    static let roof = SIMD3<Double>(120, 118, 110)
    static let panel = SIMD3<Double>(28, 74, 140)
    static let sun = SIMD3<Double>(-0.35, -0.55, 0.76)

    /// `rgb` lit by the low sun from the southwest: 58% ambient, 42% direct.
    static func shaded(_ rgb: SIMD3<Double>, normal: SIMD3<Double>) -> Color {
        let light = 0.58 + 0.42 * max(0, (normal * sun).sum())
        let lit = rgb * light / 255
        return Color(red: lit.x, green: lit.y, blue: lit.z)
    }

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
