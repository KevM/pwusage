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

        let cacheKey = CacheKey(
            scope: scope,
            timelineFingerprint: LocalBillBuilder.timelineFingerprint(timeline),
            flowsSignature: FlowsSignature(days: flowDays),
            billingDay: billingDay
        )
        if cacheKey == lastCacheKey, case .ready = state {
            return state
        }

        let battery = timeline.battery
        let computeFn = computeReport
        let report = await Task.detached(priority: .utility) {
            let scenarios = SavingsScenarioFlows.build(days: flowDays, battery: battery)
            return computeFn(scenarios, actual, reference, billingDay, now)
        }.value

        lastCacheKey = cacheKey
        state = .ready(report)
        return state
    }

    func reset() {
        lastCacheKey = nil
        state = .notReady(.noTimeline)
    }
}
