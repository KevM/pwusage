import Foundation
import Observation
import PWUsageCore

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
        SavingsScenarioDays, RatePeriodResolver, RatePeriodResolver, Int, Date, ComponentStarts
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
    private var refreshGeneration: UInt64 = 0

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
        refreshGeneration &+= 1
        let generation = refreshGeneration
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
        let flowDays = try? await store.flowDays(scope: scope, from: .distantPast, to: now)
        guard generation == refreshGeneration else { return state }
        guard let flowDays, !flowDays.isEmpty else {
            lastCacheKey = nil
            state = .notReady(.flowsMissing)
            return state
        }

        let outcome = await computeInBackground(
            ComputeRequest(
                scope: scope,
                timeline: timeline,
                flowDays: flowDays,
                actual: actual,
                reference: reference,
                billingDay: billingDay,
                now: now
            )
        )
        guard generation == refreshGeneration else { return state }
        guard let (cacheKey, report) = outcome else {
            return state
        }

        lastCacheKey = cacheKey
        state = .ready(report)
        return state
    }

    func reset() {
        refreshGeneration &+= 1
        lastCacheKey = nil
        state = .notReady(.noTimeline)
    }

    private struct ComputeRequest {
        let scope: SolarForecastSiteScope
        let timeline: SiteTariffsTimelineResponse
        let flowDays: [EnergyFlowDay]
        let actual: RatePeriodResolver
        let reference: RatePeriodResolver
        let billingDay: Int
        let now: Date
    }

    private func computeInBackground(_ request: ComputeRequest) async -> (CacheKey, SavingsReport)? {
        let siteZone = TimeZone(identifier: request.timeline.timezone) ?? .current
        let timelineFingerprint = BillPricing.timelineFingerprint(request.timeline)
        let siteLocalDate = SolarHistoryStore.dayString(request.now, timeZone: siteZone)
        let existingCacheKey = lastCacheKey
        let hasReadyState = if case .ready = state { true } else { false }
        let battery = request.timeline.battery
        let systemCosts = request.timeline.systemCosts
        let computeFn = computeReport

        return await Task.detached(priority: .utility) {
            let cacheKey = CacheKey(
                scope: request.scope,
                timelineFingerprint: timelineFingerprint,
                flowsSignature: FlowsSignature(days: request.flowDays),
                billingDay: request.billingDay,
                siteLocalDate: siteLocalDate
            )
            if hasReadyState, cacheKey == existingCacheKey {
                return nil
            }
            let scenarios = SavingsScenarioFlows.build(
                days: request.flowDays,
                battery: battery,
                batteryStartOverride: systemCosts?.powerwall?.installDate
            )
            let starts = ComponentStarts.make(
                solarDay: systemCosts.map { $0.solar?.installDate ?? $0.siteInstalled },
                powerwallDay: systemCosts?.powerwall?.installDate ?? scenarios.batteryStartDay,
                timeZone: request.actual.siteTimeZone
            )
            let report = computeFn(
                scenarios, request.actual, request.reference, request.billingDay, request.now, starts
            )
            return (cacheKey, report)
        }.value
    }
}
