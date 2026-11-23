import CloudKit
import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Manual Solar Layout")
struct ManualSolarLayoutTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    // MARK: - CloudKit

    @Test("CloudKit round-trips three systems and eight faces")
    func cloudKitRoundTrip() throws {
        let layout = Self.layout()
        #expect(layout.systems.count == 3)
        #expect(layout.systems.flatMap(\.faces).count == 8)
        let record = SolarLayoutRecord(
            location: locA, locationSetAt: Date(timeIntervalSince1970: 1),
            manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 5))
        let ckRecord = SolarLayoutCloudRecordSerializer.makeRecord(from: record, scope: scope)
        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(ckRecord))
        #expect(parsed.record.manualLayout == layout)
        #expect(parsed.record.manualSetAt == Date(timeIntervalSince1970: 5))
    }

    @Test("A cleared layout syncs as a dated clear")
    func clearedLayoutRoundTrip() throws {
        let record = SolarLayoutRecord(
            location: locA, locationSetAt: Date(timeIntervalSince1970: 1),
            manualLayout: nil, manualSetAt: Date(timeIntervalSince1970: 9))
        let ckRecord = SolarLayoutCloudRecordSerializer.makeRecord(from: record, scope: scope)
        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(ckRecord))
        #expect(parsed.record.manualLayout == nil)
        #expect(parsed.record.manualSetAt == Date(timeIntervalSince1970: 9))
    }

    @Test("A CloudKit record from an older build parses with no manual layout")
    func olderCloudKitRecordParses() throws {
        let ckRecord = CKRecord(
            recordType: SolarLayoutCloudRecordSerializer.recordType,
            recordID: SolarLayoutCloudRecordSerializer.recordID(for: scope))
        let parsed = try #require(SolarLayoutCloudRecordSerializer.parseRecord(ckRecord))
        #expect(parsed.record.manualLayout == nil)
        #expect(parsed.record.manualSetAt == nil)
    }

    // MARK: - Store

    @Test("Setting and clearing the manual layout persists and stamps manualSetAt")
    func storeSetsAndClears() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        try await store.setLocation(locA, scope: scope)
        let layout = Self.layout()
        try await store.setManualLayout(layout, scope: scope, at: Date(timeIntervalSince1970: 7))
        var record = try #require(await store.record(scope: scope))
        #expect(record.manualLayout == layout)
        #expect(record.manualSetAt == Date(timeIntervalSince1970: 7))

        try await store.setManualLayout(nil, scope: scope, at: Date(timeIntervalSince1970: 8))
        record = try #require(await store.record(scope: scope))
        #expect(record.manualLayout == nil)
        #expect(record.manualSetAt == Date(timeIntervalSince1970: 8))
        try await store.removeAll()
    }

    @Test("Entering a layout before a location exists keeps it")
    func storeSetsBeforeLocation() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        let layout = Self.layout()
        try await store.setManualLayout(layout, scope: scope, at: .now)
        #expect(try await store.record(scope: scope)?.manualLayout == layout)
        try await store.removeAll()
    }

    @Test("Redetection and a location change leave the manual layout untouched")
    func detectionAndMoveKeepManualLayout() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        let layout = Self.layout()
        try await store.setLocation(locA, scope: scope)
        try await store.setManualLayout(layout, scope: scope, at: Date(timeIntervalSince1970: 7))

        #expect(try await store.saveResult(Self.emptyResult(.notEnoughHistory), scope: scope, for: locA, at: .now))
        #expect(try await store.record(scope: scope)?.manualLayout == layout)

        #expect(try await store.saveFailure(scope: scope, for: locA, at: .now))
        #expect(try await store.record(scope: scope)?.manualLayout == layout)

        try await store.setLocation(locB, scope: scope)
        let moved = try #require(await store.record(scope: scope))
        #expect(moved.result == nil)
        #expect(moved.manualLayout == layout)
        #expect(moved.manualSetAt == Date(timeIntervalSince1970: 7))
        try await store.removeAll()
    }

    @Test("A remote manual layout merges into the stored record")
    func storeAppliesRemoteLayout() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        try await store.setLocation(locA, scope: scope)
        let layout = Self.layout()
        let remote = SolarLayoutRecord(
            location: locA, locationSetAt: .distantPast,
            manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 5))
        try await store.applyRemoteRecord(remote, scope: scope)
        #expect(try await store.record(scope: scope)?.manualLayout == layout)
        try await store.removeAll()
    }

    // MARK: - Fixtures

    /// Three systems and eight faces: an original south install, a two-face addition and an east/west garage.
    static func layout(label: String = "Original 2016 install") -> ManualSolarLayout {
        ManualSolarLayoutFixtures.layout(label: label)
    }

    private static func emptyResult(_ status: DetectedSolarLayout.Status) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: status, confidence: nil, reasons: [], planes: [], acClipKw: nil,
            historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
    }

    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("manual-layout-\(UUID().uuidString)")
    }
}
