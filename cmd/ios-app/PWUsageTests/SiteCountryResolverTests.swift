import Foundation
@testable import PWUsage
import Testing

@Suite("Site country from the saved home location")
struct SiteCountryResolverTests {
    private static func inference(_ latitude: Double, _ longitude: Double) throws -> SiteCountryInference {
        let resolver = try #require(SiteCountryResolver.bundled, "The bundled country outlines load")
        return resolver.inference(for: SolarHomeLocation(latitude: latitude, longitude: longitude, source: .device))
    }

    private static func stored(
        _ code: String?,
        _ source: RateCountrySource?,
        _ eligibility: RatePlanEligibility = .unknown
    ) -> SiteRateCountryDTO {
        SiteRateCountryDTO(countryCode: code, source: source, updatedAt: nil, eligibility: eligibility)
    }

    @Test("Inland sites resolve to their country, including US territories", arguments: [
        (41.88, -87.63, "US"), // Chicago
        (21.31, -157.86, "US"), // Honolulu
        (61.22, -149.90, "US"), // Anchorage
        (18.47, -66.11, "PR"), // San Juan
        (43.65, -79.38, "CA"), // Toronto
        (19.43, -99.13, "MX"), // Mexico City
        (48.86, 2.35, "FR"), // Paris
        (-33.87, 151.21, "AU") // Sydney
    ])
    func resolves(latitude: Double, longitude: Double, code: String) throws {
        #expect(try Self.inference(latitude, longitude) == .resolved(countryCode: code))
    }

    @Test("A site within the margin of another country is uncertain")
    func nearBorder() throws {
        // Detroit's riverfront faces Windsor, Ontario, across the Detroit River.
        guard case .nearBorder(let candidates) = try Self.inference(42.33, -83.04) else {
            Issue.record("Expected an uncertain result near the border")
            return
        }
        #expect(Set(candidates) == ["US", "CA"])
        // San Diego's border crossing at San Ysidro.
        guard case .nearBorder(let southern) = try Self.inference(32.54, -117.03) else {
            Issue.record("Expected an uncertain result at the Mexican border")
            return
        }
        #expect(Set(southern) == ["US", "MX"])
    }

    @Test("Open sea, territories without an ISO code and missing locations stay unresolved")
    func unresolved() throws {
        #expect(try Self.inference(30, -40) == .unresolved)
        #expect(try Self.inference(42.66, 21.17) == .unresolved, "Pristina, Kosovo has no ISO 3166 code")
        let resolver = try #require(SiteCountryResolver.bundled)
        #expect(resolver.inference(for: nil) == .noLocation)
        #expect(resolver.inference(for: SolarHomeLocation(latitude: 120, longitude: 0, source: .device)) == .noLocation)
    }

    @Test("Malformed boundary data is rejected")
    func malformed() {
        #expect(throws: CountryBoundaries.LoadError.malformed) { try CountryBoundaries(data: Data("PWCB".utf8)) }
        #expect(throws: CountryBoundaries.LoadError.malformed) { try CountryBoundaries(data: Data("nope!!!".utf8)) }
    }

    @Test("An owner's choice and older servers are never overwritten")
    func ownerWins() {
        let owner = Self.stored("CA", .owner, .outsideUS)
        #expect(SiteCountryResolver.action(stored: owner, inference: .resolved(countryCode: "US")) == .keep)
        #expect(SiteCountryResolver.action(stored: owner, inference: .unresolved) == .keep)
        #expect(SiteCountryResolver.action(stored: nil, inference: .resolved(countryCode: "US")) == .keep)
    }

    @Test("Inference is reported only when it changes, and a failed one clears a stale inference")
    func reporting() {
        let unknown = Self.stored(nil, nil)
        let inferredUS = Self.stored("US", .solarLocation, .unitedStates)
        #expect(SiteCountryResolver.action(stored: unknown, inference: .resolved(countryCode: "US"))
            == .report(countryCode: "US"))
        #expect(SiteCountryResolver.action(stored: inferredUS, inference: .resolved(countryCode: "US")) == .keep)
        #expect(SiteCountryResolver.action(stored: inferredUS, inference: .resolved(countryCode: "CA"))
            == .report(countryCode: "CA"))
        #expect(SiteCountryResolver.action(stored: inferredUS, inference: .nearBorder(candidates: ["US", "CA"]))
            == .report(countryCode: nil))
        #expect(SiteCountryResolver.action(stored: inferredUS, inference: .unresolved) == .report(countryCode: nil))
        #expect(SiteCountryResolver.action(stored: unknown, inference: .unresolved) == .keep)
        #expect(SiteCountryResolver.action(stored: inferredUS, inference: .noLocation) == .keep,
                "A location that hasn't synced to this device yet keeps the stored inference")
    }

    @Test("The owner is asked only when nothing resolves an unknown country")
    func ownerChoice() {
        let unknown = Self.stored(nil, nil)
        #expect(SiteCountryResolver.needsOwnerChoice(stored: unknown, inference: .noLocation))
        #expect(SiteCountryResolver.needsOwnerChoice(stored: unknown, inference: .nearBorder(candidates: ["US", "CA"])))
        #expect(!SiteCountryResolver.needsOwnerChoice(stored: unknown, inference: .resolved(countryCode: "US")))
        let inferred = Self.stored("US", .solarLocation, .unitedStates)
        #expect(!SiteCountryResolver.needsOwnerChoice(stored: inferred, inference: .noLocation))
        #expect(!SiteCountryResolver.needsOwnerChoice(stored: nil, inference: .noLocation))
    }
}
