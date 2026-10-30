import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Automatic solar forecast foreground lifecycle")
struct AutomaticForecastLifecycleTests {
    private static let pending = MobileSolarLayoutResponse.enabled(
        location: SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device), layout: nil, reason: .pending
    )

    @Test("Pending detection revalidates at 15 minutes and publishes once detected, without another appearance")
    func pendingThenDetected() async {
        let harness = AutomaticForecastHarness()
        harness.coordinator.scenePhaseChanged(isActive: true)
        harness.api.layout = Self.pending
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.scheduler.pending.map(\.delay) == [15 * 60])
        harness.api.clock.advance(by: 15 * 60)
        await harness.scheduler.fire()
        #expect(harness.api.layoutSiteIDs.count == 2)
        #expect(harness.scheduler.pending.count == 1, "Still pending, so it is rescheduled")
        harness.api.layout = AutomaticForecastAPISpy.detected
        harness.api.clock.advance(by: 15 * 60)
        await harness.scheduler.fire()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.scheduler.pending.isEmpty)
    }

    @Test("A transient failure during pending revalidation schedules a bounded retry")
    func retryAfterTransientFailure() async {
        let harness = AutomaticForecastHarness()
        harness.coordinator.scenePhaseChanged(isActive: true)
        harness.api.layout = Self.pending
        await harness.coordinator.loadTimingDetailAppeared()
        harness.api.layoutError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        harness.api.clock.advance(by: 15 * 60)
        await harness.scheduler.fire()
        #expect(harness.scheduler.pending.map(\.delay) == [SolarLayoutCacheEntry.retryDelay])
        harness.api.layoutError = nil
        harness.api.layout = AutomaticForecastAPISpy.detected
        harness.api.clock.advance(by: SolarLayoutCacheEntry.retryDelay)
        await harness.scheduler.fire()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.scheduler.pending.isEmpty)
    }

    @Test("Revalidation is cancelled by leaving the view, backgrounding or switching site")
    func cancellation() async {
        for leave in 0 ..< 3 {
            let harness = AutomaticForecastHarness()
            harness.coordinator.scenePhaseChanged(isActive: true)
            harness.api.layout = Self.pending
            await harness.coordinator.loadTimingDetailAppeared()
            #expect(harness.scheduler.pending.count == 1)
            switch leave {
            case 0: harness.coordinator.solarSurfaceDisappeared()
            case 1: harness.coordinator.scenePhaseChanged(isActive: false)
            default: harness.coordinator.selectSite("site-b")
            }
            #expect(harness.scheduler.pending.isEmpty, "case \(leave)")
        }
    }

    @Test("Repeated appearances coalesce into one scheduled revalidation")
    func coalesced() async {
        let harness = AutomaticForecastHarness()
        harness.coordinator.scenePhaseChanged(isActive: true)
        harness.api.layout = Self.pending
        await harness.coordinator.loadTimingDetailAppeared()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.scheduler.pending.count == 1)
        #expect(harness.api.layoutSiteIDs.count == 1, "A cached transitional status is reused inside 15 minutes")
    }

    @Test("A transient layout failure keeps a validated publication; expiry or rejection clears it")
    func transientFailure() async {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        harness.api.layoutError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        await harness.coordinator.loadTimingDetailRefreshed()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        harness.api.clock.advance(by: 6 * 3600 + 60)
        await harness.coordinator.loadTimingDetailRefreshed()
        #expect(harness.coordinator.solarForecastSource == nil)

        let rejected = AutomaticForecastHarness()
        await rejected.coordinator.loadTimingDetailAppeared()
        rejected.api.layoutError = PWUsageAPIError.requestRejected(statusCode: 403, message: nil)
        await rejected.coordinator.loadTimingDetailRefreshed()
        #expect(rejected.coordinator.solarForecastSource == nil)
        #expect(rejected.coordinator.solarLayoutStatus == nil)
    }

    @Test("A role revoked on revalidation clears the automatic forecast")
    func revoked() async {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        harness.api.layout = .disabled
        await harness.coordinator.loadTimingDetailRefreshed()
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)
    }
}
