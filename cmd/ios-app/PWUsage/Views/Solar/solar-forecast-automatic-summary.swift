import Foundation

extension SolarForecastSettingsStatus {
    /// Ordered lines for the settings sheet's automatic forecast section: source, panel faces,
    /// then confidence or the reason there is no layout yet. Empty outside the beta. The
    /// source's name comes from its registered descriptor.
    static func automaticSummary(
        response: MobileSolarLayoutResponse,
        source: SolarForecastProviderDescriptor?
    ) -> [String] {
        guard case .enabled(let location, let layout, let reason) = response else { return [] }
        var lines: [String] = []
        if let source {
            lines.append(source.requirement == .detectedLayout
                ? "Automatic forecast from \(source.displayName)" : "Forecast from \(source.displayName)")
        }
        if let layout {
            let count = layout.planes.count
            let faces = layout.planes.map { "\(compassName($0.azimuth))-facing about \(kilowatts($0.dcKwp)) kW" }
            lines.append("\(count) panel \(count == 1 ? "face" : "faces"): \(faces.joined(separator: ", "))")
            lines.append(layout.confidence == .high ? "High confidence" : "Medium confidence")
        } else if let reason {
            lines.append(sentence(for: reason))
        }
        if location?.source == .estimated { lines.append("Your location is approximate") }
        return lines
    }

    static func sentence(for reason: MobileSolarLayoutReason) -> String {
        switch reason {
        case .needsLocation: "Share your home location so we can work out which way your panels face."
        case .pending: "Waiting for your panel layout to be detected."
        case .notEnoughHistory: "We need about 6 weeks of solar history first"
        case .lowConfidence: "Your production doesn't match a clear panel layout yet"
        }
    }

    /// Eight-point compass name for a bearing in degrees.
    static func compassName(_ azimuth: Double) -> String {
        let names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
        let normalized = (azimuth.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        return names[Int((normalized / 45).rounded()) % names.count]
    }

    /// One decimal, without a trailing `.0`.
    static func kilowatts(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
    }
}
