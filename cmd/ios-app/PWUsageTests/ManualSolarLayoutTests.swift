import CloudKit
import Foundation
@testable import PWUsage
import Testing

@Suite("Manual Solar Layout")
struct ManualSolarLayoutTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    // MARK: - Record

    @Test("A record stored before manual layouts decodes with no manual layout")
    func legacyRecordDecodes() throws {
        let legacy = """
        {"location":{"latitude":37.77,"longitude":-122.41,"source":"device"},"locationSetAt":100}
        """
        let record = try JSONDecoder().decode(SolarLayoutRecord.self, from: Data(legacy.utf8))
        #expect(record.location == locA)
        #expect(record.manualLayout == nil)
        #expect(record.manualSetAt == nil)
    }

    @Test("A manual layout survives a JSON round trip")
    func jsonRoundTrip() throws {
        let record = SolarLayoutRecord(
            location: locA, locationSetAt: Date(timeIntervalSince1970: 1),
            manualLayout: Self.layout(), manualSetAt: Date(timeIntervalSince1970: 5))
        let decoded = try JSONDecoder().decode(SolarLayoutRecord.self, from: JSONEncoder().encode(record))
        #expect(decoded == record)
    }

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

    // MARK: - Merge

    @Test("The later manualSetAt wins in either direction")
    func laterManualSetAtWins() {
        let older = Self.layout(label: "older")
        let newer = Self.layout(label: "newer")
        let local = SolarLayoutRecord(location: locA, manualLayout: older, manualSetAt: Date(timeIntervalSince1970: 1))
        let remote = SolarLayoutRecord(location: locA, manualLayout: newer, manualSetAt: Date(timeIntervalSince1970: 2))
        #expect(SolarLayoutCloudMerge.merge(local: local, remote: remote).manualLayout == newer)
        #expect(SolarLayoutCloudMerge.merge(local: remote, remote: local).manualLayout == newer)
    }

    @Test("A dated clear beats an older layout, and a newer layout beats an older clear")
    func clearIsLastWriterWins() {
        let layout = Self.layout()
        let entered = SolarLayoutRecord(
            location: locA, manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 1))
        let cleared = SolarLayoutRecord(location: locA, manualLayout: nil, manualSetAt: Date(timeIntervalSince1970: 2))
        let merged = SolarLayoutCloudMerge.merge(local: entered, remote: cleared)
        #expect(merged.manualLayout == nil)
        #expect(merged.manualSetAt == Date(timeIntervalSince1970: 2))

        let reentered = SolarLayoutRecord(
            location: locA, manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 3))
        #expect(SolarLayoutCloudMerge.merge(local: reentered, remote: cleared).manualLayout == layout)
    }

    @Test("A dated layout beats a record that never set one")
    func datedBeatsUndated() {
        let layout = Self.layout()
        let entered = SolarLayoutRecord(
            location: locA, manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 1))
        let untouched = SolarLayoutRecord(location: locA)
        #expect(SolarLayoutCloudMerge.merge(local: untouched, remote: entered).manualLayout == layout)
        #expect(SolarLayoutCloudMerge.merge(local: entered, remote: untouched).manualLayout == layout)
        #expect(SolarLayoutCloudMerge.merge(local: nil, remote: entered).manualLayout == layout)
        #expect(SolarLayoutCloudMerge.merge(local: untouched, remote: untouched).manualLayout == nil)
    }

    @Test("The manual layout is independent of which location wins")
    func manualLayoutIgnoresLocationWinner() {
        let layout = Self.layout()
        let local = SolarLayoutRecord(
            location: locA, locationSetAt: Date(timeIntervalSince1970: 1),
            manualLayout: layout, manualSetAt: Date(timeIntervalSince1970: 1))
        let remote = SolarLayoutRecord(location: locB, locationSetAt: Date(timeIntervalSince1970: 9))
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        #expect(merged.location == locB)
        #expect(merged.manualLayout == layout)
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
        ManualSolarLayout(systems: [
            ManualSolarSystem(
                label: label, installDate: Date(timeIntervalSince1970: 1_450_000_000), inverterAcKw: 7.6,
                faces: [
                    face("South roof", 14, 285, azimuth: 180, tilt: 22),
                    face("West roof", 6, 285, azimuth: 270, tilt: 22),
                    face("Porch", 2, 285, azimuth: nil, tilt: nil)
                ]),
            ManualSolarSystem(
                label: "2023 addition", installDate: Date(timeIntervalSince1970: 1_680_000_000), inverterAcKw: nil,
                faces: [
                    face("South roof", 8, 410, azimuth: 180, tilt: 22),
                    face(nil, 4, 410, azimuth: 90, tilt: 22)
                ]),
            ManualSolarSystem(
                label: nil, installDate: nil, inverterAcKw: nil,
                faces: [
                    face("Garage east", 5, 400, azimuth: 90, tilt: 15),
                    face("Garage west", 5, 400, azimuth: 270, tilt: 15),
                    face("Shed", 1, 400, azimuth: 180, tilt: 10)
                ])
        ])
    }

    private static func face(
        _ label: String?, _ panels: Int, _ watts: Double, azimuth: Double?, tilt: Double?
    ) -> ManualSolarFace {
        ManualSolarFace(label: label, panelCount: panels, panelWatts: watts, azimuthDegrees: azimuth, tiltDegrees: tilt)
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
