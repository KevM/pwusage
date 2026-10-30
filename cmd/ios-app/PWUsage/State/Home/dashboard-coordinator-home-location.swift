import Foundation

enum SolarLocationShareResult: Equatable {
    case shared
    case denied
    case restricted
    case unavailable
    case failed
    /// The account or site changed before the fix arrived, so nothing was sent.
    case cancelled

    /// Only a permission the user can change in Settings gets the Open Settings button.
    var offersOpenSettings: Bool { self == .denied || self == .restricted }
}

extension DashboardCoordinator {
    /// Called only after the user confirmed they are at `confirmedSiteID`. Takes one fix,
    /// posts it only if that account and site are still selected, then reads the layout again
    /// so the server's pending status shows. Nothing here retries on its own.
    func shareHomeLocation(
        confirmedSiteID: String,
        provider: any HomeLocationProviding
    ) async -> SolarLocationShareResult {
        guard canRequestAccountData, let layoutAPI, let accountScopeID,
              confirmedSiteID == selectedSiteID else { return .cancelled }
        let generation = siteGeneration
        let location: SolarHomeLocation
        do {
            location = try await provider.currentRoundedLocation()
        } catch let error as HomeLocationError {
            switch error {
            case .denied: return .denied
            case .restricted: return .restricted
            case .unavailable: return .unavailable
            }
        } catch {
            return .cancelled
        }
        guard generation == siteGeneration, confirmedSiteID == selectedSiteID, canRequestAccountData,
              accountScopeID == self.accountScopeID else { return .cancelled }
        do {
            try await layoutAPI.postSolarLocation(
                siteID: confirmedSiteID, latitude: location.latitude, longitude: location.longitude
            )
        } catch {
            return .failed
        }
        guard generation == siteGeneration, confirmedSiteID == selectedSiteID else { return .cancelled }
        invalidateSolarLayout()
        await loadTimingDetailAppeared(surface: nil)
        return .shared
    }

    /// Settings always reads a fresh status when it opens.
    func solarSettingsAppeared() async {
        guard !Task.isCancelled else { return }
        solarSurfaceAppeared(.settings)
        guard layoutAPI != nil else { return }
        invalidateSolarLayout()
        await loadTimingDetailAppeared(surface: nil)
    }
}
