import Foundation
import PWUsageCore

extension DashboardCoordinator {
    /// The country the selected site's saved home location points to, worked out on the device.
    func siteCountryInference() async -> SiteCountryInference {
        await Self.inferCountry(from: savedHomeLocation(siteID: selectedSiteID))
    }

    /// Reports the inferred country when it differs from the stored one. Coordinates never
    /// leave the device. An owner's choice is never replaced, and the result is dropped if the
    /// account, site or saved location changed while it was being worked out. Returns the
    /// server's updated timeline when a country was reported.
    @discardableResult
    func syncSiteRateCountry(stored: SiteRateCountryDTO) async -> SiteTariffsTimelineResponse? {
        guard canRequestAccountData, stored.source != .owner else { return nil }
        let generation = siteGeneration
        let siteID = selectedSiteID
        let location = await savedHomeLocation(siteID: siteID)
        let inference = await Self.inferCountry(from: location)
        guard case .report(let countryCode) = SiteCountryResolver.action(stored: stored, inference: inference) else {
            return nil
        }
        let current = await savedHomeLocation(siteID: siteID)
        guard generation == siteGeneration, siteID == selectedSiteID, current == location,
              canRequestAccountData, !Task.isCancelled else { return nil }
        do {
            return try await setSiteRateCountry(countryCode, source: .solarLocation)
        } catch {
            // Background inference: the next timeline load tries again.
            return nil
        }
    }

    private func savedHomeLocation(siteID: String) async -> SolarHomeLocation? {
        guard let scope = tariffScope(siteID: siteID) else { return nil }
        do {
            return try await records.record(scope: scope)?.location
        } catch {
            return nil
        }
    }

    /// Runs off the main actor: the first call loads the bundled outlines.
    nonisolated private static func inferCountry(from location: SolarHomeLocation?) async -> SiteCountryInference {
        await Task.detached(priority: .utility) {
            // Without the bundled outlines, behave as if there were no location: keep what is stored.
            SiteCountryResolver.bundled?.inference(for: location) ?? .noLocation
        }.value
    }
}
