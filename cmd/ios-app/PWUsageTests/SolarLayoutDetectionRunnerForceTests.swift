import Foundation
import os
@testable import PWUsage
import Testing

@Suite("Solar Layout Detection forced runs")
struct SolarLayoutDetectionRunnerForceTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let location = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    private let attempt = Date(timeIntervalSince1970: 1_000_000)

    @Test("A forced run detects again before the ordinary cadence is due")
    @MainActor
    func forcedRunIgnoresCadence() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("records"))
        let history = SolarHistoryStore(directory: folder.appendingPathComponent("history"))
        try await records.setLocation(location, scope: scope, at: attempt)
        let day = MobileSolarHistoryDay(day: "1970-01-12", dayStart: attempt, status: .complete,
                                        fetchedAt: attempt, solarWh: Array(repeating: 0, count: 288))
        let page = MobileSolarHistoryResponse.enabled(timeZone: .gmt, days: [day], nextFrom: nil)
        let api = HistoryAPI(responses: [page, page, page])
        let low = DetectedSolarLayout(status: .lowConfidence, confidence: "low", reasons: [], planes: [],
                                      acClipKw: nil, historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    calls.withLock { $0 += 1 }
                                                    return low
                                                }, now: { self.attempt })
        _ = await runner.runIfDue(scope: scope)
        _ = await runner.runIfDue(scope: scope)
        #expect(calls.withLock { $0 } == 1)
        let forced = await runner.runIfDue(scope: scope, force: true)
        #expect(forced?.result == low)
        #expect(calls.withLock { $0 } == 2)
        try? FileManager.default.removeItem(at: folder)
    }
}
