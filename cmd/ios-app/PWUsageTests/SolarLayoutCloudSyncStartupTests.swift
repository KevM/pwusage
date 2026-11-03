import Foundation
@testable import PWUsage
import Testing

extension SolarLayoutCloudSyncTests {
    @Test("The first iCloud start holds back a missing location until it returns")
    @MainActor
    func firstStartHoldsBackAMissingLocation() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let gate = LifecycleGate()
        let transport = FakeSolarCloudTransport(lookupGate: gate)
        let model = try cloudSyncModel(harness: harness, transport: transport)
        _ = model.ensureAccountScopeID()
        #expect(model.awaitsSolarCloudRecords == false)
        model.startSolarCloudSync()
        try await eventually { gate.isHolding }
        #expect(model.awaitsSolarCloudRecords)
        gate.release()
        try await eventually { !model.awaitsSolarCloudRecords }
    }
}
