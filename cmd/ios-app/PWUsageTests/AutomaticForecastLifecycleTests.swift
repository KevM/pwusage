import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Automatic solar forecast foreground lifecycle")
struct AutomaticForecastLifecycleTests {
    @Test("Pending detection updates to detected when runner completes without a timer")
    func pendingThenDetected() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        harness.coordinator.scenePhaseChanged(isActive: true)
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        guard case .enabled(_, _, let reason) = harness.coordinator.solarLayoutStatus else {
            Issue.record("Expected enabled status")
            return
        }
        #expect(reason == .pending)

        // Detection completes on runner, which fires onRecordChanged and reloads
        try await eventually {
            harness.coordinator.solarForecastSource == .forecastSolar
        }
        #expect(harness.coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse)
    }

    @Test("Revalidation is cancelled by leaving the view, backgrounding or switching site")
    func cancellation() async throws {
        for leave in 0 ..< 3 {
            let harness = await AutomaticForecastHarness(seedDetected: false)
            try await harness.setPending()
            harness.coordinator.scenePhaseChanged(isActive: true)
            await harness.coordinator.loadTimingDetailAppeared()
            switch leave {
            case 0: harness.coordinator.solarSurfaceDisappeared()
            case 1: harness.coordinator.scenePhaseChanged(isActive: false)
            default: harness.coordinator.selectSite("site-b")
            }
            // Runner cancel was called, so no in-flight task remains
            try await staysTrue {
                harness.coordinator.solarLayoutStatus != AutomaticForecastHarness.detectedResponse
            }
        }
    }

    @Test("Repeated appearances coalesce detection into a single run")
    func coalesced() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        harness.coordinator.scenePhaseChanged(isActive: true)
        await harness.coordinator.loadTimingDetailAppeared()
        await harness.coordinator.loadTimingDetailAppeared()
        try await eventually {
            harness.coordinator.solarForecastSource == .forecastSolar
        }
        #expect(harness.coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse)
        // A single initial sync issues exactly two fetches: the 364-day UTC discovery page,
        // followed by the 365-day site-local exact start page (Task 7 contract).
        #expect(harness.api.historyFetches.count == 2)
    }

    @Test("A role revoked on revalidation clears the automatic forecast")
    func revoked() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        harness.coordinator.historyEnabled = false
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.loadTimingDetailRefreshed()
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)
    }
}
