import CloudKit
import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Layout Cloud Sync Deletion")
struct SolarLayoutCloudSyncDeletionTests {
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)

    @Test("Delete record removes local record, pending scopes, and enqueues engine deletion")
    @MainActor
    func deleteRecordPurgesLocalAndSendsEngineDeletion() async throws {
        let transport = FakeSolarCloudTransport()
        let harness = try SolarCloudLifecycleHarness(transport: transport.transport)
        defer { harness.removeFiles() }
        let session = harness.sync.issueSession(accountScopeID: "acc-1")
        await harness.sync.start(session: session)
        let scope = SolarForecastSiteScope(accountScopeID: "acc-1", siteID: "site-1")
        try await harness.records.setLocation(locA, scope: scope)
        try await eventually { (try? harness.persistedPendingScopes()) == [scope] }

        try await harness.sync.deleteRecord(scope: scope)

        #expect(try await harness.freshRecord(scope) == nil)
        #expect(try harness.persistedPendingScopes().isEmpty)
        let engine = try #require(transport.engines.last)
        let expectedRecordID = SolarLayoutCloudRecordSerializer.recordID(for: scope)
        #expect(engine.pendingDeletions.contains(expectedRecordID))
        #expect(engine.counts.sends > 0)
    }
}
