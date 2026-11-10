#if DEBUG
    import SwiftUI

    enum DashboardPreviewMode: String {
        case normal
        case empty
        case stale
        case modestSurplus
        case abundantSurplus
        case noFit
        case unknownBalance
        case tariffCrossing
        case longLevel1
        case noTariff
        case error
    }

    extension MobileSite {
        static let preview = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")
    }

    /// An account with several sites, for previewing the site picker and the
    /// sidebar's site menu. Each site answers with the normal fixture under its
    /// own id and name, so the coordinator accepts it after a switch.
    @MainActor
    final class MultiSitePreviewAPI: PWUsageApplicationAPI {
        static let sites = [
            MobileSite.preview,
            MobileSite(id: "preview-cabin", name: "Lakeside Cabin", utility: "North Shore Electric"),
            MobileSite(id: "preview-office", name: "Main Street Office", utility: "City Power & Light"),
            MobileSite(id: "preview-ranch", name: "Hill Country Ranch", utility: "Pedernales Co-op"),
            MobileSite(id: "preview-rental", name: "Elm Street Rental", utility: "Demo utility")
        ]

        let sites: [MobileSite]

        init(sites: [MobileSite] = MultiSitePreviewAPI.sites) {
            self.sites = sites
        }

        private func fixture(for siteID: String) -> DashboardPreviewAPI {
            DashboardPreviewAPI(mode: .normal, site: sites.first(where: { $0.id == siteID }) ?? .preview)
        }

        func fetchSites() async throws -> [MobileSite] { sites }
        func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
            try await fixture(for: siteID).fetchLive(siteID: siteID)
        }
        func fetchBill(siteID: String) async throws -> MobileBillResponse {
            try await fixture(for: siteID).fetchBill(siteID: siteID)
        }
        func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
            throw URLError(.notConnectedToInternet)
        }
        func fetchSolarHistory(
            siteID: String, from: String, changedSince: Date?
        ) async throws -> MobileSolarHistoryResponse {
            .enabled(timeZone: .gmt, days: [], nextFrom: nil)
        }
        func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] { [] }
        func fetchTrmnlPreview(siteID: String) async throws -> String { throw URLError(.notConnectedToInternet) }
        func setBillingDay(siteID: String, day: Int) async throws -> MobileBillingDay {
            MobileBillingDay(billingDay: day, billingDayConfirmed: true)
        }
        func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
        func logout() async throws {}
        func clearSiteAuthCookie() async {}
    }

    extension PWUsageAppModel {
        /// A signed-in model for `api`'s sites, already showing `tab`. Built from a
        /// seeded cache, so it never bootstraps or reaches the network.
        static func preview(api: MultiSitePreviewAPI = MultiSitePreviewAPI(), tab: AppTab = .home) -> PWUsageAppModel {
            let suiteName = "pwusage.preview.multi-site.\(tab.rawValue)"
            let defaults = PreviewDefaults.suite(suiteName)
            defaults.set(tab.rawValue, forKey: selectedTabDefaultsKey)
            let cache = DashboardCache(fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("\(suiteName)-\(UUID().uuidString).json"))
            cache.storeSites(api.sites)
            return PWUsageAppModel(
                configuration: .debugFallback,
                api: api,
                userDefaults: defaults,
                coordinatorFactory: { siteID, _ in DashboardCoordinator(siteID: siteID, api: api, timerInterval: nil) },
                cache: cache
            )
        }
    }

    @MainActor
    private struct DashboardPreview: View {
        @StateObject private var coordinator: DashboardCoordinator
        private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

        init(mode: DashboardPreviewMode) {
            let api = DashboardPreviewAPI(mode: mode)
            _coordinator = StateObject(
                wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
        }

        var body: some View {
            NavigationStack {
                DashboardView(coordinator: coordinator, site: site, onOpenTab: { _ in })
            }
            .task {
                coordinator.scenePhaseChanged(isActive: true)
                await coordinator.refreshDue()
            }
        }
    }

    @MainActor
    private struct BillPreview: View {
        @StateObject private var coordinator: DashboardCoordinator
        private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

        init() {
            let api = DashboardPreviewAPI(mode: .normal)
            _coordinator = StateObject(
                wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
        }

        var body: some View {
            NavigationStack {
                BillView(coordinator: coordinator, site: site)
            }
            .task {
                coordinator.scenePhaseChanged(isActive: true)
                await coordinator.refreshDue()
            }
        }
    }

    @MainActor
    private struct LoadTimingPreview: View {
        @StateObject private var coordinator: DashboardCoordinator
        private let profileStore: LoadProfileStore
        private let exploredProfileID: String?
        private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

        init(mode: DashboardPreviewMode, exploredProfileID: String? = nil) {
            let api = DashboardPreviewAPI(mode: mode)
            _coordinator = StateObject(
                wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
            let suiteName = "pwusage.preview.load-timing.\(mode.rawValue)"
            let defaults = PreviewDefaults.suite(suiteName)
            let store = LoadProfileStore(userDefaults: defaults)
            if mode == .longLevel1 {
                _ = try? store.editProfile(
                    id: "car", energyKwh: 36, durationHours: 24,
                    carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20,
                                                 targetStateOfCharge: 80, chargingLevel: .level1))
            }
            profileStore = store
            self.exploredProfileID = exploredProfileID
        }

        var body: some View {
            NavigationStack {
                LoadTimingView(coordinator: coordinator, site: site, profileStore: profileStore,
                               initialExploredProfileID: exploredProfileID)
            }
            .task {
                coordinator.scenePhaseChanged(isActive: true)
                await coordinator.refreshDue()
            }
        }
    }

    #Preview("Dashboard · Normal") {
        DashboardPreview(mode: .normal)
    }

    #Preview("Dashboard · iPad landscape", traits: .landscapeLeft, .fixedLayout(width: 1180, height: 820)) {
        // A fixed layout alone can report a compact size class, so pin it to regular.
        DashboardPreview(mode: .normal)
            .environment(\.horizontalSizeClass, .regular)
    }

    #Preview("Dashboard · No energy") {
        DashboardPreview(mode: .empty)
    }

    #Preview("Dashboard · Stale source") {
        DashboardPreview(mode: .stale)
    }

    #Preview("Dashboard · Accessibility text") {
        DashboardPreview(mode: .normal)
            .environment(\.dynamicTypeSize, .accessibility2)
    }

    #Preview("Dashboard · Unavailable") {
        DashboardPreview(mode: .error)
    }

    #Preview("Current bill") {
        BillPreview()
    }

    #Preview("Load timing · Normal") {
        LoadTimingPreview(mode: .normal)
    }

    #Preview("Load timing · No cycle data") {
        LoadTimingPreview(mode: .empty)
    }

    #Preview("Load timing · Stale source") {
        LoadTimingPreview(mode: .stale)
    }

    #Preview("Load timing · Modest surplus") {
        LoadTimingPreview(mode: .modestSurplus)
    }

    #Preview("Load timing · Abundant surplus") {
        LoadTimingPreview(mode: .abundantSurplus)
    }

    #Preview("Load timing · Alternative estimate") {
        LoadTimingPreview(mode: .abundantSurplus, exploredProfileID: "washer")
    }

    #Preview("Load timing · No fit") {
        LoadTimingPreview(mode: .noFit)
    }

    #Preview("Load timing · Unknown balance") {
        LoadTimingPreview(mode: .unknownBalance)
    }

    #Preview("Load timing · Tariff crossing") {
        LoadTimingPreview(mode: .tariffCrossing)
    }

    #Preview("Load timing · Long Level 1") {
        LoadTimingPreview(mode: .longLevel1)
    }

    #Preview("Load timing · Accessibility text") {
        LoadTimingPreview(mode: .normal)
            .environment(\.dynamicTypeSize, .accessibility2)
    }

    #Preview("Load timing · No tariff") {
        LoadTimingPreview(mode: .noTariff)
    }
#endif
