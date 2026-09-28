#if DEBUG
import Foundation
import SwiftUI

/// Synthetic, offline forecast fixtures for Load timing previews. No Solcast key
/// or account data is present anywhere in this file.
enum ForecastPreviewMode: String, CaseIterable {
    /// Two selected arrays (east + west) summed into one batch.
    case combinedArrays
    /// A run that crosses a tariff transition.
    case tariffCrossing
    /// A long Level 1 car charge over many forecast intervals.
    case longCharge
    /// Cached batch present but older than the six-hour recommendation freshness.
    case staleCache
    /// Key saved, arrays not chosen yet.
    case incompleteArraySelection
    /// No historical household context available.
    case missingContext
}

private actor PreviewForecastStore: SolarForecastManaging {
    private let mode: ForecastPreviewMode
    private let now: Date

    init(mode: ForecastPreviewMode, now: Date) {
        self.mode = mode
        self.now = now
    }

    private var hasCredential: Bool { mode != .incompleteArraySelection }

    private var resourceIDs: [String] {
        mode == .combinedArrays ? ["east-1234", "west-5678"] : ["east-1234"]
    }

    private var fetchedAt: Date {
        mode == .staleCache ? now.addingTimeInterval(-9 * 60 * 60) : now.addingTimeInterval(-25 * 60)
    }

    /// A believable day: nothing overnight, a broad midday peak, tapering tails.
    private func intervals() -> [SolarForecastInterval] {
        let step: TimeInterval = 30 * 60
        let start = now.addingTimeInterval(-30 * 60)
        return (0..<48).map { index in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
            let hour = Calendar(identifier: .gregorian).component(.hour, from: periodStart)
            let solarShape: Double
            switch hour {
            case 5...8: solarShape = 0.25
            case 9...11: solarShape = 0.8
            case 12...14: solarShape = 1.0
            case 15...17: solarShape = 0.7
            case 18...19: solarShape = 0.2
            default: solarShape = 0
            }
            // Combined arrays carry a higher ceiling than a single array.
            let ceiling = mode == .combinedArrays ? 9.0 : 5.0
            let scale = mode == .longCharge ? 0.75 : 1.0
            return SolarForecastInterval(
                periodStart: periodStart,
                periodEnd: periodStart.addingTimeInterval(step),
                powerKw: ceiling * solarShape * scale
            )
        }
    }

    private var batch: SolarForecastBatch {
        SolarForecastBatch(credentialID: "preview-credential", resourceIDs: resourceIDs,
                           intervals: intervals(), fetchedAt: fetchedAt)
    }

    func activateAccountScope(_ accountScopeID: String?) async {}

    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential? {
        guard hasCredential else { return nil }
        return SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID,
                                       credentialID: "preview-credential", resourceIDs: resourceIDs)
    }

    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?) async throws -> String {
        "preview-credential"
    }

    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) async throws -> [SolcastSite] {
        [SolcastSite(resourceID: "east-1234", name: "East array", tags: ["roof-north"]),
         SolcastSite(resourceID: "west-5678", name: "West array", tags: ["roof-south", "shaded"])]
    }

    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws {}

    func refresh(accountScopeID: String, siteID: String, manual: Bool) async -> SolarForecastRefreshResult {
        guard hasCredential, !resourceIDs.isEmpty else { return .notConfigured }
        return mode == .staleCache ? .deferred : .refreshed
    }

    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch? {
        hasCredential ? batch : nil
    }

    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool {
        hasCredential && mode != .staleCache
    }

    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget {
        SolarForecastBudget(utcDay: now, totalAttempts: 2, automaticAttempts: 1, deferredUntil: nil)
    }

    func disconnect(accountScopeID: String, siteID: String) async throws {}
}

@MainActor
private final class PreviewPlanningAPI: MobileLoadPlanningDataAPI {
    private let mode: ForecastPreviewMode
    private let response: MobileLoadPlanningContextResponse

    init(mode: ForecastPreviewMode, now: Date) {
        self.mode = mode
        let slots: [MobileLoadPlanningContextResponse.Slot] = (0..<48).map { index in
            let minute = index * 30
            // Missing context stays absent; it is never reported as zero.
            let absent = mode == .missingContext && (8...20).contains(minute / 60)
            return MobileLoadPlanningContextResponse.Slot(
                localMinute: minute,
                homeKw: absent ? nil : 0.35,
                batteryNetChargeKw: absent ? nil : 0.1,
                sampleCount: absent ? 0 : 12,
                coverage: absent ? 0 : 1
            )
        }
        response = MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: "preview-home", timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: now,
            availability: mode == .missingContext ? .unavailable : .available,
            unavailableReason: mode == .missingContext ? "not_enough_days" : nil,
            usableDayCount: mode == .missingContext ? 3 : 14,
            historyStart: now.addingTimeInterval(-14 * 86400),
            historyEnd: now.addingTimeInterval(-86400),
            slots: slots
        )
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        response
    }
}

@MainActor
private struct SolarForecastPreview: View {
    @StateObject private var coordinator: DashboardCoordinator
    private let profileStore: LoadProfileStore
    private let mode: ForecastPreviewMode
    private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

    init(mode: ForecastPreviewMode) {
        self.mode = mode
        let api = DashboardPreviewAPI(mode: .normal)
        let now = Date.now
        _coordinator = StateObject(wrappedValue: DashboardCoordinator(
            siteID: "preview-home",
            api: api,
            planningAPI: PreviewPlanningAPI(mode: mode, now: now),
            forecastStore: PreviewForecastStore(mode: mode, now: now),
            accountScopeID: "preview-account",
            now: { now },
            timerInterval: nil
        ))
        let suiteName = "pwusage.preview.solar.\(mode.rawValue)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        let store = LoadProfileStore(userDefaults: defaults)
        if mode == .longCharge {
            _ = try? store.editProfile(id: "car", energyKwh: 36, durationHours: 20,
                                       carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20,
                                                                    targetStateOfCharge: 80, chargingLevel: .level1))
        }
        profileStore = store
    }

    var body: some View {
        NavigationStack {
            LoadTimingView(coordinator: coordinator, site: site, profileStore: profileStore)
        }
        .task {
            coordinator.scenePhaseChanged(isActive: true)
            await coordinator.loadTimingDetailAppeared()
        }
    }
}

#Preview("Solar · Combined east + west") {
    SolarForecastPreview(mode: .combinedArrays)
}

#Preview("Solar · Tariff crossing") {
    SolarForecastPreview(mode: .tariffCrossing)
}

#Preview("Solar · Long Level 1 charge") {
    SolarForecastPreview(mode: .longCharge)
}

#Preview("Solar · Stale cache") {
    SolarForecastPreview(mode: .staleCache)
}

#Preview("Solar · Arrays not chosen") {
    SolarForecastPreview(mode: .incompleteArraySelection)
}

#Preview("Solar · Missing household context") {
    SolarForecastPreview(mode: .missingContext)
}

#Preview("Solar · Accessibility text") {
    SolarForecastPreview(mode: .combinedArrays)
        .environment(\.dynamicTypeSize, .accessibility2)
}
#endif
