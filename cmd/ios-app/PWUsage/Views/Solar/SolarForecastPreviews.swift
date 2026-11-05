#if DEBUG
    import CryptoKit
    import Foundation
    import SwiftUI

    /// The preview site's timezone. The bill fixture, the planning context, and the
    /// synthetic solar curve must all agree: the coordinator rejects the enhancement
    /// when the bill's site timezone and the planning context's differ.
    let sitePreviewTimeZone = "America/Chicago"

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
        /// No historical household context available.
        case missingContext
        /// A modest array while Peak is a net buyer: the basic layer has no
        /// suggestion, so the forecast renders on the explorer card.
        case peakDeficit
    }

    actor PreviewForecastStore: SolarForecastProviding {
        private static let descriptorValue = SolarForecastProviderDescriptor(
            id: .openMeteo, displayName: "Open-Meteo",
            attribution: "Automatic forecast from Open-Meteo.",
            requirement: .detectedLayout, providesCautiousPower: true,
            refreshThreshold: 1800, maximumUsableAge: 86400 * 7, modelVersion: "preview-v1"
        )

        nonisolated var descriptor: SolarForecastProviderDescriptor { Self.descriptorValue }

        private let mode: ForecastPreviewMode
        private let now: Date

        init(mode: ForecastPreviewMode, now: Date) {
            self.mode = mode
            self.now = now
        }

        private var fetchedAt: Date {
            mode == .staleCache ? now.addingTimeInterval(-9 * 60 * 60) : now.addingTimeInterval(-25 * 60)
        }

        /// A believable day: nothing overnight, a broad midday peak, tapering tails.
        /// Shaped in the site's local time so it lines up with the planning slots.
        func intervals() -> [SolarForecastInterval] {
            let step: TimeInterval = 30 * 60
            let start = now.addingTimeInterval(-30 * 60)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: sitePreviewTimeZone) ?? .current
            return (0 ..< 120).map { index in
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
                    powerKw: ceiling * solarShape * scale,
                    cautiousPowerKw: ceiling * solarShape * scale * 0.8
                )
            }
        }

        func rawBatch() -> SolarForecastRawBatch {
            SolarForecastRawBatch(
                providerID: .openMeteo,
                fingerprint: "preview-fingerprint",
                cacheRevision: "preview-revision",
                intervals: intervals(),
                fetchedAt: fetchedAt,
                acClipKw: nil
            )
        }

        func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
            SolarForecastConfiguration(
                readiness: .ready, fingerprint: "preview-fingerprint", cacheRevision: "preview-revision"
            )
        }

        func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
            SolarForecastProviderResult(batch: rawBatch(), outcome: .refreshed)
        }

        func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? {
            rawBatch()
        }

        func activateAccountScope(_ accountScopeID: String?) async {}
        func clearAccountData() async throws {}
    }

    @MainActor
    final class PreviewPlanningAPI: MobileLoadPlanningDataAPI {
        private let response: MobileLoadPlanningContextResponse

        init(mode: ForecastPreviewMode, now: Date) {
            let slots: [MobileLoadPlanningContextResponse.Slot] = (0 ..< 48).map { index in
                let minute = index * 30
                let absent = mode == .missingContext && (8 ... 20).contains(minute / 60)
                return MobileLoadPlanningContextResponse.Slot(
                    localMinute: minute, homeKw: absent ? nil : 0.35,
                    batteryNetChargeKw: absent ? nil : 0.1,
                    sampleCount: absent ? 0 : 12, coverage: absent ? 0 : 1
                )
            }
            response = MobileLoadPlanningContextResponse(
                version: 1, site: .init(id: "preview-home", timezone: sitePreviewTimeZone),
                units: .init(power: "kW", localMinute: "minute-of-day"), asOf: now,
                availability: mode == .missingContext ? .unavailable : .available,
                unavailableReason: mode == .missingContext ? "not_enough_days" : nil,
                usableDayCount: mode == .missingContext ? 3 : 14,
                historyStart: now.addingTimeInterval(-14 * 86400),
                historyEnd: now.addingTimeInterval(-86400), slots: slots
            )
        }

        func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
            response
        }
    }

    @MainActor
    private func makePreviewCoordinator(mode: ForecastPreviewMode, now: Date) -> DashboardCoordinator {
        let api = DashboardPreviewAPI(mode: .normal)
        let store = PreviewForecastStore(mode: mode, now: now)
        let service = SolarForecastService(
            providers: [store], policy: SolarForecastSelectionPolicy(automaticProviderID: .openMeteo),
            history: SolarForecastHistory(file: MemorySolarForecastFile())
        )
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("preview-\(UUID().uuidString)")
        let recordsDir = tempDir.appendingPathComponent("records")
        try? FileManager.default.createDirectory(at: recordsDir, withIntermediateDirectories: true)
        let historyStore = SolarHistoryStore(directory: tempDir.appendingPathComponent("history"))
        let scope = SolarForecastSiteScope(accountScopeID: "preview-account", siteID: "preview-home")
        let location = SolarHomeLocation(latitude: 41.8781, longitude: -87.6298, source: .device)
        let plane = DetectedSolarLayout.Plane(
            azimuth: 180, tilt: 25, dcKwp: 6.0, effectiveKw: 5.5, azimuthRange90: [170, 190], tiltRange90: [20, 30]
        )
        let detected = DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [], planes: [plane], acClipKw: nil,
            historyDays: 90, clearDays: 30, firstDay: "2025-01-01", lastDay: "2025-04-01"
        )
        let record = SolarLayoutRecord(
            location: location, locationSetAt: now, result: detected, detectedAt: now,
            attemptedAt: now, detectorVersion: SolarLayoutDetector.version, resultLocation: location
        )
        let hash = SHA256.hash(data: Data("\(scope.accountScopeID)|\(scope.siteID)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        if let data = try? JSONEncoder().encode(record) {
            try? data.write(to: recordsDir.appendingPathComponent("\(hash).json"))
        }
        let records = SolarLayoutRecordStore(directory: recordsDir) { "preview-account" }
        return DashboardCoordinator(
            siteID: "preview-home", api: api, planningAPI: PreviewPlanningAPI(mode: mode, now: now),
            accountScopeID: "preview-account", now: { now }, timerInterval: nil,
            forecastService: service, history: historyStore, records: records
        )
    }

    @MainActor
    private struct SolarForecastPreview: View {
        @StateObject private var coordinator: DashboardCoordinator
        private let profileStore: LoadProfileStore
        private let mode: ForecastPreviewMode
        private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

        init(mode: ForecastPreviewMode) {
            self.mode = mode
            let now = Date.now
            _coordinator = StateObject(wrappedValue: makePreviewCoordinator(mode: mode, now: now))
            let suiteName = "pwusage.preview.solar.\(mode.rawValue)"
            let defaults = PreviewDefaults.suite(suiteName)
            let store = LoadProfileStore(userDefaults: defaults)
            if mode == .longCharge {
                _ = try? store.editProfile(
                    id: "car", energyKwh: 36, durationHours: 20,
                    carSettings: CarLoadSettings(
                        capacityKwh: 60, initialStateOfCharge: 20,
                        targetStateOfCharge: 80, chargingLevel: .level1
                    )
                )
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

        static let timeZone = sitePreviewTimeZone
        /// 08:30 local, during Peak (or Mid for the three-period plan).
        static let now = Date(timeIntervalSince1970: 1_792_416_600) // 2026-10-19T13:30:00Z

        private static var calendar: Calendar {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone) ?? .gmt
            return calendar
        }

        private static func local(_ hours: Double) -> Date {
            calendar.startOfDay(for: now).addingTimeInterval(hours * 3600)
        }

        private struct Span {
            let from: Double
            let end: Double
            let key: String
            let buy: Double
            let sell: Double
        }

        private var spans: [Span] {
            let day: [Span]
            switch self {
            case .threePeriods:
                day = [Span(from: 0, end: 7, key: "Off-Peak", buy: 0.20, sell: 0.26),
                       Span(from: 7, end: 15, key: "Mid", buy: 0.30, sell: 0.12),
                       Span(from: 15, end: 20, key: "Peak", buy: 0.45, sell: 0.10),
                       Span(from: 20, end: 24, key: "Off-Peak", buy: 0.20, sell: 0.26)]
            default:
                day = [Span(from: 0, end: 7, key: "Off-Peak", buy: 0.20, sell: 0.26),
                       Span(from: 7, end: 16.5, key: "Peak", buy: 0.38, sell: 0.10),
                       Span(from: 16.5, end: 24, key: "Off-Peak", buy: 0.20, sell: 0.26)]
            }
            return [0.0, 24].flatMap { offset in
                day.map { Span(from: $0.from + offset, end: $0.end + offset, key: $0.key, buy: $0.buy, sell: $0.sell) }
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
            let segments = spans.map { LoadTimingTariffSegment(start: Self.local($0.from),
                                                               end: Self.local($0.end), periodKey: $0.key,
                                                               name: $0.key, buyRate: $0.buy, sellRate: $0.sell) }
            var seen: Set<String> = []
            let periods = spans.compactMap { span -> LoadTimingPeriod? in
                guard seen.insert(span.key).inserted else { return nil }
                return LoadTimingPeriod(name: span.key, marginalCost: nil, basis: "cycle-net-export",
                                        cycleNetExportKwh: balances[span.key] ?? 0, isActive: false,
                                        nextStartPhrase: nil, buyRate: span.buy, sellRate: span.sell)
            }
            return LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                              pricingPeriods: periods, tariffTimeline: segments,
                              nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        }

        private var projection: LoadTimingForecastEstimator.Projection {
            guard self == .laterWithForecast else { return .flat(timeZone: Self.timeZone) }
            let intervals = (0 ..< 96).map { index -> SolarForecastInterval in
                let start = Self.local(Double(index) / 2)
                let hour = Self.calendar.component(.hour, from: start)
                let sun = max(0, sin(Double.pi * (Double(hour) - 7) / 11))
                return SolarForecastInterval(periodStart: start,
                                             periodEnd: start.addingTimeInterval(1800), powerKw: 2.6 * sun)
            }
            let slots = stride(from: 0, to: 1440, by: 30).map {
                LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: 0.7, batteryNetChargeKw: 0)
            }
            return .forecast(intervals: intervals,
                             context: .init(timeZone: Self.timeZone, slots: slots, asOf: Self.now))
        }

        var screen: SmartShiftScreen {
            let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
                                  carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 60,
                                                               targetStateOfCharge: 80, chargingLevel: .level2))
            let plan = LoadTimingForecastEstimator.plan(.init(
                now: Self.now, timing: timing, projection: projection, balanceSourceTime: Self.now,
                billingCycleEnd: Self.now.addingTimeInterval(20 * 86_400), currencyCode: "USD"))
            let result = LoadTimingForecastEstimator.evaluate(profile: car, plan: plan)
            return SmartShiftPresentation.make(
                profile: car, result: result, forecast: self == .laterWithForecast ? .ready : .none,
                refreshUnavailable: false,
                inputs: .init(timing: timing, now: Self.now,
                              billingCycleEnd: Self.now.addingTimeInterval(20 * 86_400), currencyCode: "USD",
                              timeZone: Self.timeZone))
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
                        SmartShiftCheckingSolarRow()
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
