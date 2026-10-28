#if DEBUG
    import Foundation
    import SwiftUI

    /// The preview site's timezone. The bill fixture, the planning context, and the
    /// synthetic solar curve must all agree: the coordinator rejects the enhancement
    /// when the bill's site timezone and the planning context's differ.
    let SITE_PREVIEW_TIME_ZONE = "America/Chicago"

    /// Synthetic, offline forecast fixtures for Load timing previews. No Solcast key
    /// or account data is present anywhere in this file.
    enum ForecastPreviewMode: String {
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
        /// A modest array while Peak is a net buyer: the basic layer has no
        /// suggestion, so the forecast renders on the explorer card.
        case peakDeficit
    }

    actor PreviewForecastStore: SolarForecastManaging {
        private let mode: ForecastPreviewMode
        private let now: Date

        init(mode: ForecastPreviewMode, now: Date) {
            self.mode = mode
            self.now = now
        }

        private var hasCredential: Bool { mode != .incompleteArraySelection }

        private var resourceIDs: [String] {
            switch mode {
            case .combinedArrays: ["east-1234", "west-5678"]
            default: ["east-1234"]
            }
        }

        private var fetchedAt: Date {
            mode == .staleCache ? now.addingTimeInterval(-9 * 60 * 60) : now.addingTimeInterval(-25 * 60)
        }

        /// A believable day: nothing overnight, a broad midday peak, tapering tails.
        /// Shaped in the site's local time so it lines up with the planning slots.
        private func intervals() -> [SolarForecastInterval] {
            let step: TimeInterval = 30 * 60
            let start = now.addingTimeInterval(-30 * 60)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: SITE_PREVIEW_TIME_ZONE) ?? .current
            return (0 ..< 48).map { index in
                let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
                let hour = calendar.component(.hour, from: periodStart)
                let solarShape: Double
                switch hour {
                case 5 ... 8: solarShape = 0.25
                case 9 ... 11: solarShape = 0.8
                case 12 ... 14: solarShape = 1.0
                case 15 ... 17: solarShape = 0.7
                case 18 ... 19: solarShape = 0.2
                default: solarShape = 0
                }
                // Combined arrays carry a higher ceiling than a single array.
                let ceiling: Double = switch mode {
                case .combinedArrays: 9.0
                case .peakDeficit: 2.5
                default: 5.0
                }
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
        func signOut() async throws {}
    }

    @MainActor
    final class PreviewPlanningAPI: MobileLoadPlanningDataAPI {
        private let mode: ForecastPreviewMode
        private let response: MobileLoadPlanningContextResponse

        init(mode: ForecastPreviewMode, now: Date) {
            self.mode = mode
            let slots: [MobileLoadPlanningContextResponse.Slot] = (0 ..< 48).map { index in
                let minute = index * 30
                // Missing context stays absent; it is never reported as zero.
                let absent = mode == .missingContext && (8 ... 20).contains(minute / 60)
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
                site: .init(id: "preview-home", timezone: SITE_PREVIEW_TIME_ZONE),
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

    #Preview("Solar · Peak deficit · forecast on the explorer card") {
        SolarForecastPreview(mode: .peakDeficit)
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

    /// Fixture verdicts for the Smart Shift card, built by running the real estimator
    /// and `SmartShiftPresentation.make` on synthetic Chicago inputs.
    enum SmartShiftPreviewFixture: String {
        case laterWithForecast
        case laterWithoutForecast
        case nowIsCheapest
        case threePeriods

        static let timeZone = SITE_PREVIEW_TIME_ZONE
        /// 08:30 local, during Peak (or Mid for the three-period plan).
        static let now = ISO8601DateFormatter().date(from: "2026-10-19T13:30:00Z")!

        private static var calendar: Calendar {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone)!
            return calendar
        }

        private static func local(_ hours: Double) -> Date {
            calendar.startOfDay(for: now).addingTimeInterval(hours * 3600)
        }

        private struct Span {
            let from: Double
            let to: Double
            let key: String
            let buy: Double
            let sell: Double
        }

        private var spans: [Span] {
            let day: [Span]
            switch self {
            case .threePeriods:
                day = [Span(from: 0, to: 7, key: "Off-Peak", buy: 0.20, sell: 0.26),
                       Span(from: 7, to: 15, key: "Mid", buy: 0.30, sell: 0.12),
                       Span(from: 15, to: 20, key: "Peak", buy: 0.45, sell: 0.10),
                       Span(from: 20, to: 24, key: "Off-Peak", buy: 0.20, sell: 0.26)]
            default:
                day = [Span(from: 0, to: 7, key: "Off-Peak", buy: 0.20, sell: 0.26),
                       Span(from: 7, to: 16.5, key: "Peak", buy: 0.38, sell: 0.10),
                       Span(from: 16.5, to: 24, key: "Off-Peak", buy: 0.20, sell: 0.26)]
            }
            return [0.0, 24].flatMap { offset in
                day.map { Span(from: $0.from + offset, to: $0.to + offset, key: $0.key, buy: $0.buy, sell: $0.sell) }
            }
        }

        private var balances: [String: Double] {
            switch self {
            case .threePeriods: ["Off-Peak": 18, "Mid": -4, "Peak": 6]
            case .nowIsCheapest: ["Off-Peak": 18, "Peak": 40]
            // Solar lifts Peak through the day, so it starts deep enough to stay owed.
            case .laterWithForecast: ["Off-Peak": 30, "Peak": -40]
            default: ["Off-Peak": 18, "Peak": -6]
            }
        }

        private var timing: LoadTiming {
            let segments = spans.map {
                LoadTimingTariffSegment(start: Self.local($0.from), end: Self.local($0.to), periodKey: $0.key, name: $0.key,
                                        buyRate: $0.buy, sellRate: $0.sell)
            }
            var seen: Set<String> = []
            let periods = spans.compactMap { span -> LoadTimingPeriod? in
                guard seen.insert(span.key).inserted else { return nil }
                return LoadTimingPeriod(name: span.key, marginalCost: nil, basis: "cycle-net-export",
                                        cycleNetExportKwh: balances[span.key] ?? 0, isActive: false, nextStartPhrase: nil,
                                        buyRate: span.buy, sellRate: span.sell)
            }
            return LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                              pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                              nextStartPhraseByKey: [:])
        }

        private var projection: LoadTimingForecastEstimator.Projection {
            guard self == .laterWithForecast else { return .flat(timeZone: Self.timeZone) }
            let intervals = (0 ..< 96).map { index -> SolarForecastInterval in
                let start = Self.local(Double(index) / 2)
                let hour = Self.calendar.component(.hour, from: start)
                let sun = max(0, sin(Double.pi * (Double(hour) - 7) / 11))
                return SolarForecastInterval(periodStart: start, periodEnd: start.addingTimeInterval(1800), powerKw: 2.6 * sun)
            }
            let slots = stride(from: 0, to: 1440, by: 30).map {
                LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: 0.7, batteryNetChargeKw: 0)
            }
            return .forecast(intervals: intervals, context: .init(timeZone: Self.timeZone, slots: slots, asOf: Self.now))
        }

        var screen: SmartShiftScreen {
            let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
                                  carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 60,
                                                               targetStateOfCharge: 80, chargingLevel: .level2))
            let result = LoadTimingForecastEstimator.evaluate(
                profile: car, now: Self.now, timing: timing, projection: projection, balanceSourceTime: Self.now,
                billingCycleEnd: Self.now.addingTimeInterval(20 * 86_400), currencyCode: "USD")
            return SmartShiftPresentation.make(
                profile: car, result: result, forecast: self == .laterWithForecast ? .ready : .none,
                refreshUnavailable: false, timing: timing, now: Self.now,
                billingCycleEnd: Self.now.addingTimeInterval(20 * 86_400), currencyCode: "USD", timeZone: Self.timeZone)
        }
    }

    private struct SmartShiftVerdictPreview: View {
        let fixture: SmartShiftPreviewFixture

        var body: some View {
            ScrollView {
                Group {
                    switch fixture.screen.content {
                    case .verdict(let verdict):
                        SmartShiftVerdictView(verdict: verdict, timeZone: SmartShiftPreviewFixture.timeZone)
                    case .blocked(let message):
                        Text(message)
                    case .loading:
                        ProgressView(SmartShiftPresentation.checkingSolarNote)
                    case .noJobs:
                        Text("Add a Job")
                    }
                }
                .padding()
                .background { SectionTheme.loadTiming.cardBackground }
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding()
            }
            .background { SectionTheme.loadTiming.screenBackground }
        }
    }

    #Preview("Smart Shift · Later start with forecast") {
        SmartShiftVerdictPreview(fixture: .laterWithForecast)
    }

    #Preview("Smart Shift · Later start without forecast") {
        SmartShiftVerdictPreview(fixture: .laterWithoutForecast)
    }

    #Preview("Smart Shift · Now is cheapest") {
        SmartShiftVerdictPreview(fixture: .nowIsCheapest)
    }

    #Preview("Smart Shift · Three rate periods") {
        SmartShiftVerdictPreview(fixture: .threePeriods)
    }

    #Preview("Smart Shift · Later start, dark") {
        SmartShiftVerdictPreview(fixture: .laterWithoutForecast)
            .preferredColorScheme(.dark)
    }
#endif
