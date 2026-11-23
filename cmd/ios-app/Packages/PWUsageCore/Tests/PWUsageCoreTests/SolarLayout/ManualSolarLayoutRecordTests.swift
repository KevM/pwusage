import Foundation
@testable import PWUsageCore
import Testing

@Suite("Manual Solar Layout record")
struct ManualSolarLayoutRecordTests {
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

    static func layout(label: String = "Original 2016 install") -> ManualSolarLayout {
        ManualSolarLayoutFixtures.layout(label: label)
    }
}
