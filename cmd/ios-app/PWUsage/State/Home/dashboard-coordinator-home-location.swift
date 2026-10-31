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
    /// saves it locally to records, and triggers on-device detection if due.
    func shareHomeLocation(
        confirmedSiteID: String,
        provider: any HomeLocationProviding
    ) async -> SolarLocationShareResult {
        guard canRequestAccountData, let accountScopeID,
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
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: confirmedSiteID)
        do {
            try await records.setLocation(location, scope: scope, at: now())
        } catch {
            return .failed
        }
        guard generation == siteGeneration, confirmedSiteID == selectedSiteID else { return .cancelled }
        Task { [weak self] in
            _ = await self?.runner?.runIfDue(scope: scope)
        }
        invalidateSolarLayout()
        await loadTimingDetailAppeared(surface: nil)
        return .shared
    }

    /// Settings always reads a fresh status when it opens.
    func solarSettingsAppeared() async {
        guard !Task.isCancelled else { return }
        solarSurfaceAppeared(.settings)
        invalidateSolarLayout()
        await loadTimingDetailAppeared(surface: nil)
    }
}
