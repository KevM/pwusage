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
                                                }, now: { attempt })
        _ = await runner.runIfDue(scope: scope)
        _ = await runner.runIfDue(scope: scope)
        #expect(calls.withLock { $0 } == 1)
        let forced = await runner.runIfDue(scope: scope, force: true)
        #expect(forced?.result == low)
        #expect(calls.withLock { $0 } == 2)
        try? FileManager.default.removeItem(at: folder)
    }

    @Test("Forced joins reassess imported samples; ordinary joins share the result", arguments: [true, false])
    @MainActor
    func joinedRunUsesUpdatedHistory(force: Bool) async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let records = SolarLayoutRecordStore(directory: folder.appendingPathComponent("records"))
        let history = SolarHistoryStore(directory: folder.appendingPathComponent("history"))
        try await records.setLocation(location, scope: scope, at: attempt)
        let day = MobileSolarHistoryDay(day: "1970-01-12", dayStart: attempt, status: .complete,
                                        fetchedAt: attempt, solarWh: Array(repeating: 1, count: 288))
        let page = MobileSolarHistoryResponse.enabled(timeZone: .gmt, days: [day], nextFrom: nil)
        let api = HistoryAPI(responses: [page, page])
        let gate = DetectionGate()
        let sampleCounts = OSAllocatedUnfairLock(initialState: [Int]())
        let runner = SolarLayoutDetectionRunner(
            history: history, records: records, api: api,
            detect: { samples, _, _, _, _ in
                sampleCounts.withLock { $0.append(samples.count) }
                gate.onDetect()
                return DetectedSolarLayout(status: .lowConfidence, confidence: "low", reasons: [], planes: [],
                                           acClipKw: nil, historyDays: samples.count / 288, clearDays: 0,
                                           firstDay: nil, lastDay: nil)
            }, now: { attempt })
        let ordinary = Task { await runner.runIfDue(scope: scope) }
        try await eventually { gate.callCount == 1 }
        let imported = MobileSolarHistoryDay(
            day: "1970-01-11", dayStart: attempt.addingTimeInterval(-86_400), status: .complete,
            fetchedAt: attempt, solarWh: Array(repeating: 2, count: 288))
        try await history.merge(MobileSolarHistoryFill(
            timeZone: .gmt, status: .complete, historyStart: "1970-01-11", days: [imported]), scope: scope)
        let joined = Task { await runner.runIfDue(scope: scope, force: force) }
        try await staysTrue(for: .milliseconds(100)) { gate.callCount == 1 }
        gate.proceed()
        let first = await ordinary.value
        let second = await joined.value
        #expect(first?.result?.historyDays == 1)
        #expect(second?.result?.historyDays == (force ? 2 : 1))
        #expect(sampleCounts.withLock { $0 } == (force ? [288, 576] : [288]))
    }
}
