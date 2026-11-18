import Foundation

/// What the saved home location says about a site's country.
enum SiteCountryInference: Equatable, Sendable {
    case resolved(countryCode: String)
    /// Within the border margin of another country: the owner must choose. Nearest first.
    case nearBorder(candidates: [String])
    /// Outside every known country (open sea, or a territory with no ISO code).
    case unresolved
    /// No saved home location for this site on this device.
    case noLocation
}

/// What to tell PWUsage about the site's country after an inference.
enum SiteRateCountryAction: Equatable, Sendable {
    case keep
    /// Report this inferred country (or clear a stale inference with nil), source `solar_location`.
    case report(countryCode: String?)
}

/// Finds a site's country on the device from its saved, rounded home location. Only the
/// resulting country code is sent to PWUsage; the coordinates stay on the phone.
struct SiteCountryResolver: Sendable {
    /// Saved locations are rounded to about 1 km and 1:50m outlines can sit a few kilometers
    /// off the true border, so anything this close to another country is uncertain.
    static let borderMarginKilometers = 5.0
    /// Marks Natural Earth areas with no ISO code; a site there is unresolved.
    static let unknownTerritory = "--"

    /// Loaded once, off the main actor, on first use.
    static let bundled: SiteCountryResolver? = (try? CountryBoundaries.bundled()).map(Self.init)

    let boundaries: CountryBoundaries

    func inference(for location: SolarHomeLocation?) -> SiteCountryInference {
        guard let location, location.isValid else { return .noLocation }
        let point = CountryBoundaries.Point(longitude: location.longitude, latitude: location.latitude)
        let nearby = boundaries.countries(within: Self.borderMarginKilometers, of: point)
        let candidates: [String]
        if let inside = boundaries.country(containing: point) {
            guard inside != Self.unknownTerritory else { return .unresolved }
            candidates = [inside] + nearby.filter { $0 != inside }
        } else {
            candidates = nearby
        }
        let known = candidates.filter { $0 != Self.unknownTerritory }
        if candidates.count == 1, let only = known.first {
            return .resolved(countryCode: only)
        }
        return known.isEmpty ? .unresolved : .nearBorder(candidates: known)
    }

    /// An owner's choice is never overwritten; an older server (no stored country) is left alone.
    /// A missing location keeps the stored inference, since it may just not have synced yet, but a
    /// saved location that no longer resolves clears it back to unknown rather than leaving it stale.
    static func action(stored: SiteRateCountryDTO?, inference: SiteCountryInference) -> SiteRateCountryAction {
        guard let stored, stored.source != .owner else { return .keep }
        switch inference {
        case .resolved(let code):
            return stored.countryCode == code && stored.source == .solarLocation ? .keep : .report(countryCode: code)
        case .nearBorder, .unresolved:
            return stored.source == .solarLocation ? .report(countryCode: nil) : .keep
        case .noLocation:
            return .keep
        }
    }

    /// Whether the app should ask the owner for the site's country.
    static func needsOwnerChoice(stored: SiteRateCountryDTO?, inference: SiteCountryInference) -> Bool {
        guard let stored, stored.source != .owner, stored.eligibility == .unknown else { return false }
        if case .resolved = inference { return false }
        return true
    }
}
