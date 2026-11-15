import Foundation
import Observation

enum SavingsNotReadyReason: Equatable, Sendable {
    case flowsMissing
    case noTimeline
    case noReferencePlan
}

enum SavingsState: Equatable, Sendable {
    case notReady(SavingsNotReadyReason)
    case ready(SavingsReport)
}

@Observable
@MainActor
final class SavingsModel {
    typealias ComputeReport = @Sendable (
        SavingsScenarioDays, RatePeriodResolver, RatePeriodResolver, Int, Date
    ) -> SavingsReport

    private struct FlowsSignature: Equatable, Sendable {
        let dayCount: Int
        let contentHash: UInt64

        init(days: [EnergyFlowDay]) {
            self.dayCount = days.count
            var hash: UInt64 = 14_695_981_039_346_656_037
            for day in days {
                for byte in day.day.utf8 {
                    hash = Self.fnvMix(hash, UInt64(byte))
                }
                hash = Self.mixSamples(hash, day.gridWh)
                hash = Self.mixSamples(hash, day.solarWh)
                hash = Self.mixSamples(hash, day.loadWh)
                hash = Self.mixSamples(hash, day.batteryWh)
            }
            self.contentHash = hash
        }

        private static func mixSamples(_ hash: UInt64, _ samples: [Float?]) -> UInt64 {
            var current = fnvMix(hash, UInt64(samples.count))
            for sample in samples {
                current = fnvMix(current, sample.map { UInt64($0.bitPattern) } ?? 0xFFFF_FFFF_0000_0000)
            }
            return current
        }

        private static func fnvMix(_ hash: UInt64, _ value: UInt64) -> UInt64 {
            (hash ^ value) &* 1_099_511_628_211
        }
    }

    private struct CacheKey: Equatable, Sendable {
        let scope: SolarForecastSiteScope
        let timelineFingerprint: String
        let flowsSignature: FlowsSignature
        let billingDay: Int
        let siteLocalDate: String
    }

    private(set) var state: SavingsState = .notReady(.noTimeline)
    private var lastCacheKey: CacheKey?

    private let store: SolarHistoryStore
    private let computeReport: ComputeReport

    init(
        store: SolarHistoryStore = .shared,
        computeReport: @escaping ComputeReport = SavingsCalculator.compute
    ) {
        self.store = store
        self.computeReport = computeReport
    }

    @discardableResult
    func refresh(
        scope: SolarForecastSiteScope,
        timeline: SiteTariffsTimelineResponse?,
        billingDay: Int,
        now: Date = .now
    ) async -> SavingsState {
        guard let timeline,
              !timeline.periods.isEmpty,
              let actual = RatePeriodResolver(timeline: timeline) else {
            lastCacheKey = nil
            state = .notReady(.noTimeline)
            return state
        }
        guard let reference = RatePeriodResolver(referenceOf: timeline) else {
            lastCacheKey = nil
            state = .notReady(.noReferencePlan)
            return state
        }
        guard let flowDays = try? await store.flowDays(scope: scope, from: .distantPast, to: now),
              !flowDays.isEmpty else {
            lastCacheKey = nil
            state = .notReady(.flowsMissing)
            return state
        }

        let siteZone = TimeZone(identifier: timeline.timezone) ?? .current
        let timelineFingerprint = LocalBillBuilder.timelineFingerprint(timeline)
        let siteLocalDate = SolarHistoryStore.dayString(now, timeZone: siteZone)
        let existingCacheKey = lastCacheKey
        let hasReadyState = if case .ready = state { true } else { false }
        let battery = timeline.battery
        let computeFn = computeReport

        let outcome: (CacheKey, SavingsReport)? = await Task.detached(priority: .utility) {
            let cacheKey = CacheKey(
                scope: scope,
                timelineFingerprint: timelineFingerprint,
                flowsSignature: FlowsSignature(days: flowDays),
                billingDay: billingDay,
                siteLocalDate: siteLocalDate
            )
            if hasReadyState, cacheKey == existingCacheKey {
                return nil
            }
            let scenarios = SavingsScenarioFlows.build(days: flowDays, battery: battery)
            let report = computeFn(scenarios, actual, reference, billingDay, now)
            return (cacheKey, report)
        }.value

        guard let (cacheKey, report) = outcome else {
            return state
        }

        lastCacheKey = cacheKey
        state = .ready(report)
        return state
    }

    func reset() {
        lastCacheKey = nil
        state = .notReady(.noTimeline)
    }
}
