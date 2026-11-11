import Foundation

/// The glyphs a job can wear. Each is an SF Symbol name; a job with none saved shows its usual glyph.
enum JobGlyphs {
    static let gallery: [String] = [
        "car.fill", "bolt.car.fill", "ev.charger.fill", "bicycle", "scooter",
        "dishwasher.fill", "washer.fill", "dryer.fill", "oven.fill", "microwave.fill", "refrigerator.fill",
        "fork.knife", "flame.fill", "thermometer.sun.fill", "fan.fill",
        "drop.fill", "figure.pool.swim", "bathtub.fill", "shower.fill",
        "air.conditioner.horizontal.fill", "heater.vertical.fill", "lightbulb.fill",
        "powerplug.fill", "bolt.fill", "laptopcomputer", "tv.fill",
        "leaf.fill", "wrench.and.screwdriver.fill", "hammer.fill", "slider.horizontal.3"
    ]

    private static let starterSymbols: [String: String] = [
        "car": "car.fill", "dishwasher": "dishwasher.fill", "washer": "washer.fill",
        "dryer": "dryer.fill", "washer-dryer-combo": "washer.fill"
    ]

    static func symbol(for profile: LoadProfile) -> String {
        if let chosen = profile.symbol?.trimmingCharacters(in: .whitespacesAndNewlines), !chosen.isEmpty {
            return chosen
        }
        if let starter = starterSymbols[profile.id] { return starter }
        switch profile.kind {
        case .car: return "car.fill"
        case .appliance: return "powerplug.fill"
        case .custom: return "slider.horizontal.3"
        }
    }
}
