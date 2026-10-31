import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Layout Record Store")
struct SolarLayoutRecordStoreTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let location = SolarHomeLocation(latitude: 43.391, longitude: -87.874, source: .device)

    @Test("Rounds locations before storage and persists records")
    func roundsAndReloads() async throws {
        let folder = temporaryFolder()
        let store = SolarLayoutRecordStore(directory: folder)
        try await store.setLocation(location, scope: scope, at: Date(timeIntervalSince1970: 1))
        let record = try #require(await store.record(scope: scope))
        #expect(record.location == SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device))
        let reloaded = SolarLayoutRecordStore(directory: folder)
        #expect(try await reloaded.record(scope: scope) == record)
        try await store.removeAll()
    }

    @Test("Location changes clear results but same rounded location preserves them")
    func locationChangesInvalidateResult() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        try await store.setLocation(location, scope: scope)
        #expect(try await store.saveResult(result(.notEnoughHistory), scope: scope, for: location, at: .now))
        try await store.setLocation(
            SolarHomeLocation(latitude: 43.394, longitude: -87.873, source: .device), scope: scope)
        #expect(try await store.record(scope: scope)?.result != nil)
        try await store.setLocation(
            SolarHomeLocation(latitude: 43.394, longitude: -87.873, source: .estimated), scope: scope)
        #expect(try await store.record(scope: scope)?.result != nil)
        try await store.setLocation(
            SolarHomeLocation(latitude: 43.40, longitude: -87.87, source: .device), scope: scope)
        #expect(try await store.record(scope: scope)?.result == nil)
        try await store.removeAll()
    }

    @Test("Rejects stale results after the location moves")
    func rejectsStaleSave() async throws {
        let store = SolarLayoutRecordStore(directory: temporaryFolder())
        try await store.setLocation(location, scope: scope)
        try await store.setLocation(SolarHomeLocation(latitude: 44, longitude: -87, source: .device), scope: scope)
        #expect(try await !store.saveResult(result(.notEnoughHistory), scope: scope, for: location, at: .now))
        try await store.removeAll()
    }

    @Test("Maps first-run and disabled states")
    func mapsEmptyStates() {
        let empty = SolarLayoutRecord(location: nil, locationSetAt: nil, result: nil, detectedAt: nil,
                                      attemptedAt: nil, detectorVersion: nil, resultLocation: nil)
        #expect(empty.response(historyEnabled: false) == .disabled)
        #expect(empty.response(historyEnabled: true) == .enabled(location: nil, layout: nil, reason: .needsLocation))
    }

    @Test("Maps detector results and rejects stale detector versions")
    func mapsDetectorStates() {
        let rounded = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
        func expectReason(_ status: DetectedSolarLayout.Status, _ reason: MobileSolarLayoutReason) {
            let record = makeRecord(location: rounded, result: result(status), detectedAt: .now,
                                    detectorVersion: SolarLayoutDetector.version, resultLocation: rounded)
            #expect(record.response(historyEnabled: true) == .enabled(location: rounded, layout: nil, reason: reason))
        }
        expectReason(.notEnoughHistory, .notEnoughHistory)
        expectReason(.lowConfidence, .lowConfidence)
        expectReason(.failed, .pending)
        let stale = makeRecord(location: rounded, result: result(.notEnoughHistory), detectedAt: .now,
                               detectorVersion: -1, resultLocation: rounded)
        #expect(stale.response(historyEnabled: true) == .enabled(location: rounded, layout: nil, reason: .pending))
        let detected = makeRecord(location: rounded, result: result(.detected), detectedAt: .now,
                                  detectorVersion: SolarLayoutDetector.version, resultLocation: rounded)
        if case .enabled(let actual, let layout, let reason) = detected.response(historyEnabled: true) {
            #expect(actual == rounded)
            #expect(layout?.planes.count == 1)
            #expect(layout?.confidence == .high)
            #expect(reason == nil)
        } else {
            Issue.record("Expected enabled detected layout")
        }
    }

    private func makeRecord(
        location: SolarHomeLocation, result: DetectedSolarLayout, detectedAt: Date,
        detectorVersion: Int, resultLocation: SolarHomeLocation
    ) -> SolarLayoutRecord {
        SolarLayoutRecord(location: location, locationSetAt: .now, result: result, detectedAt: detectedAt,
                          attemptedAt: detectedAt, detectorVersion: detectorVersion, resultLocation: resultLocation)
    }

    private func result(_ status: DetectedSolarLayout.Status) -> DetectedSolarLayout {
        let plane = DetectedSolarLayout.Plane(azimuth: 180, tilt: 30, dcKwp: 5, effectiveKw: 4.25,
                                              azimuthRange90: [175, 185], tiltRange90: [25, 35])
        return DetectedSolarLayout(status: status, confidence: status == .detected ? "high" : nil,
                                   reasons: [], planes: status == .detected ? [plane] : [], acClipKw: nil,
                                   historyDays: 90, clearDays: 30, firstDay: nil, lastDay: nil)
    }

    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}
