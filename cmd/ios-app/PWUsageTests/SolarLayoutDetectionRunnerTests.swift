import BackgroundTasks
import Foundation
import os
@testable import PWUsage
import Testing

private struct TestDetectionError: Error, Equatable {}

@Suite("Solar Layout Detection Schedule")
struct SolarLayoutDetectionRunnerTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let location = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    private let attempt = Date(timeIntervalSince1970: 1_000_000)

    @Test("Missing, stale-version, and absent result records are due only with a location")
    func missingAndVersionDue() {
        #expect(!SolarLayoutDetectionSchedule.isDue(record(hasLocation: false), now: attempt))
        #expect(SolarLayoutDetectionSchedule.isDue(record(), now: attempt))
        #expect(SolarLayoutDetectionSchedule.isDue(record(result: result(.detected), version: 1), now: attempt))
    }

    @Test("Detected and low-confidence results use thirty days; failures use one day")
    func cadence() {
        let detected = record(result: result(.detected), version: SolarLayoutDetector.version, attemptedAt: attempt)
        let low = record(result: result(.lowConfidence), version: SolarLayoutDetector.version, attemptedAt: attempt)
        let failed = record(result: result(.failed), version: SolarLayoutDetector.version, attemptedAt: attempt)
        #expect(!SolarLayoutDetectionSchedule.isDue(detected, now: attempt.addingTimeInterval(29 * 86_400)))
        #expect(SolarLayoutDetectionSchedule.isDue(detected, now: attempt.addingTimeInterval(30 * 86_400)))
        #expect(SolarLayoutDetectionSchedule.isDue(low, now: attempt.addingTimeInterval(30 * 86_400)))
        #expect(!SolarLayoutDetectionSchedule.isDue(failed, now: attempt.addingTimeInterval(86_399)))
        #expect(SolarLayoutDetectionSchedule.isDue(failed, now: attempt.addingTimeInterval(86_400)))
        #expect(SolarLayoutDetectionSchedule.nextDue(failed) == attempt.addingTimeInterval(86_400))
    }

    @Test("Processing requests require network but not external power")
    @MainActor
    func processingRequestConfiguration() {
        let due = attempt.addingTimeInterval(86_400)
        let request = BackgroundSolarLayoutDetection.request(nextDue: due)
        #expect(request.requiresNetworkConnectivity)
        #expect(!request.requiresExternalPower)
        #expect(request.earliestBeginDate == due)
    }

    @Test("A due run saves its detector result and notifies the selected scope")
    @MainActor
    func savesDetection() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let page = historyPage(at: attempt)
        let api = HistoryAPI(responses: [page, page])
        let expected = result(.notEnoughHistory)
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in expected }, now: { self.attempt })
        var changed: SolarForecastSiteScope?
        runner.onRecordChanged = { changed = $0 }
        let saved = try #require(await runner.runIfDue(scope: scope))
        #expect(saved.result == expected)
        #expect(saved.attemptedAt == attempt)
        #expect(changed == scope)
    }

    @Test("Disabled history prevents detector execution")
    @MainActor
    func disabledHistoryStops() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [.disabled])
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    Issue.record("Detector ran while history was disabled")
                                                    return self.result(.failed)
                                                })
        #expect(await runner.runIfDue(scope: scope) == nil)
        #expect(try await records.record(scope: scope)?.result == nil)
    }

    @Test("Location change during detection discards result leaving record due")
    @MainActor
    func locationChangeDuringDetectionDiscardsResult() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let gate = DetectionGate()
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    gate.onDetect()
                                                    return self.result(.detected)
                                                }, now: { self.attempt })
        var notified = false
        runner.onRecordChanged = { _ in notified = true }
        let runTask = Task { await runner.runIfDue(scope: scope) }
        await gate.waitUntilStarted()
        let newLoc = SolarHomeLocation(latitude: 45.0, longitude: -90.0, source: .device)
        try await records.setLocation(newLoc, scope: scope, at: attempt)
        gate.proceed()
        let outcome = await runTask.value
        #expect(outcome == nil)
        #expect(!notified)
        let current = try #require(await records.record(scope: scope))
        #expect(current.location == newLoc)
        #expect(current.result == nil)
        #expect(SolarLayoutDetectionSchedule.isDue(current, now: attempt))
    }

    @Test("Location change during throwing detection discards failure leaving record due")
    @MainActor
    func locationChangeDuringThrowingDetectionDiscardsFailure() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let gate = DetectionGate()
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    gate.onDetect()
                                                    throw TestDetectionError()
                                                }, now: { self.attempt })
        var notified = false
        runner.onRecordChanged = { _ in notified = true }
        let runTask = Task { await runner.runIfDue(scope: scope) }
        await gate.waitUntilStarted()
        let newLoc = SolarHomeLocation(latitude: 45.0, longitude: -90.0, source: .device)
        try await records.setLocation(newLoc, scope: scope, at: attempt)
        gate.proceed()
        let outcome = await runTask.value
        #expect(outcome == nil)
        #expect(!notified)
        let current = try #require(await records.record(scope: scope))
        #expect(current.location == newLoc)
        #expect(current.result == nil)
        #expect(SolarLayoutDetectionSchedule.isDue(current, now: attempt))
    }

    @Test("Cancel during detection leaves record due and checks cancellation")
    @MainActor
    func cancelDuringDetectionLeavesRecordDue() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let gate = DetectionGate()
        let observedCancellation = OSAllocatedUnfairLock(initialState: false)
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, checkCancellation in
                                                    gate.onDetect()
                                                    do {
                                                        try checkCancellation()
                                                    } catch is CancellationError {
                                                        observedCancellation.withLock { $0 = true }
                                                        throw CancellationError()
                                                    }
                                                    return self.result(.detected)
                                                }, now: { self.attempt })
        let runTask = Task { await runner.runIfDue(scope: scope) }
        await gate.waitUntilStarted()
        runner.cancel()
        gate.proceed()
        let outcome = await runTask.value
        #expect(outcome == nil)
        #expect(observedCancellation.withLock { $0 })
        let current = try #require(await records.record(scope: scope))
        #expect(current.result == nil)
        #expect(SolarLayoutDetectionSchedule.isDue(current, now: attempt))
    }

    @Test("Account switch mid-sync cancels old scope and runs new scope")
    @MainActor
    func accountSwitchMidSyncCancelsOldScope() async throws {
        let scopeA = SolarForecastSiteScope(accountScopeID: "acc1", siteID: "site1")
        let scopeB = SolarForecastSiteScope(accountScopeID: "acc2", siteID: "site2")
        let (records, history) = try await setupStores(scope: scopeA, location: location)
        try await records.setLocation(location, scope: scopeB, at: attempt)
        let switchingAPI = ScopeSwitchingHistoryAPI(page: historyPage(at: attempt))
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: switchingAPI,
                                                detect: { _, _, _, _, _ in self.result(.detected) },
                                                now: { self.attempt })
        var published: [SolarForecastSiteScope] = []
        runner.onRecordChanged = { published.append($0) }
        let taskA = Task { await runner.runIfDue(scope: scopeA) }
        await switchingAPI.waitUntilRequested()
        let taskB = Task { await runner.runIfDue(scope: scopeB) }
        await switchingAPI.resumeScopeA()
        let (resultA, resultB) = (await taskA.value, await taskB.value)
        #expect(resultA == nil)
        #expect(resultB?.result != nil)
        #expect(try await records.record(scope: scopeA)?.result == nil)
        #expect(try await records.record(scope: scopeB)?.result != nil)
        #expect(published == [scopeB])
    }

    @Test("Site switch mid-detection cancels old scope and runs new scope")
    @MainActor
    func siteSwitchMidDetectionCancelsOldScope() async throws {
        let scopeA = SolarForecastSiteScope(accountScopeID: "acc", siteID: "site1")
        let scopeB = SolarForecastSiteScope(accountScopeID: "acc", siteID: "site2")
        let (records, history) = try await setupStores(scope: scopeA, location: location)
        try await records.setLocation(location, scope: scopeB, at: attempt)
        let page = historyPage(at: attempt)
        let api = HistoryAPI(responses: [page, page, page, page])
        let gateA = DetectionGate()
        let runner = SolarLayoutDetectionRunner(
            history: history, records: records, api: api,
            detect: { _, latitude, _, _, _ in
                if latitude == 43.39 && gateA.callCount == 0 { gateA.onDetect() }
                return self.result(.detected)
            }, now: { self.attempt }
        )
        var published: [SolarForecastSiteScope] = []
        runner.onRecordChanged = { published.append($0) }
        let taskA = Task { await runner.runIfDue(scope: scopeA) }
        await gateA.waitUntilStarted()
        let taskB = Task { await runner.runIfDue(scope: scopeB) }
        gateA.proceed()
        let (resultA, resultB) = (await taskA.value, await taskB.value)
        #expect(resultA == nil)
        #expect(resultB?.result != nil)
        #expect(try await records.record(scope: scopeA)?.result == nil)
        #expect(try await records.record(scope: scopeB)?.result != nil)
        #expect(published == [scopeB])
    }

    @Test("Same-scope concurrent run joins and invokes detector once")
    @MainActor
    func sameScopeConcurrentRunJoins() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let gate = DetectionGate()
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    gate.onDetect()
                                                    return self.result(.detected)
                                                }, now: { self.attempt })
        let task1 = Task { await runner.runIfDue(scope: scope) }
        await gate.waitUntilStarted()
        let task2 = Task { await runner.runIfDue(scope: scope) }
        gate.proceed()
        let (first, second) = (await task1.value, await task2.value)
        #expect(first != nil)
        #expect(first == second)
        #expect(gate.callCount == 1)
    }

    @Test("Detector failure saves failed status with twenty-four hour cadence")
    @MainActor
    func detectorFailureSavesFailedStatus() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in throw TestDetectionError() },
                                                now: { self.attempt })
        let saved = try #require(await runner.runIfDue(scope: scope))
        #expect(saved.result?.status == .failed)
        #expect(saved.attemptedAt == attempt)
        #expect(!SolarLayoutDetectionSchedule.isDue(saved, now: attempt.addingTimeInterval(86_399)))
        #expect(SolarLayoutDetectionSchedule.isDue(saved, now: attempt.addingTimeInterval(86_400)))
        #expect(SolarLayoutDetectionSchedule.nextDue(saved) == attempt.addingTimeInterval(86_400))
    }

    @Test("Background launch normal path completes once with success")
    @MainActor
    func backgroundLaunchNormalPathCompletes() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in self.result(.detected) },
                                                now: { self.attempt })
        let fakeTask = FakeBackgroundTask()
        var scheduledDue: Date?
        BackgroundSolarLayoutDetection.handleLaunch(
            task: fakeTask, runner: runner, records: records, dueScope: { self.scope },
            reschedule: { scheduledDue = $0 }
        )
        try await eventually { fakeTask.completedCount == 1 }
        #expect(fakeTask.lastSuccess == true)
        #expect(fakeTask.completedCount == 1)
        #expect(scheduledDue == attempt.addingTimeInterval(30 * 86_400))
        #expect(try await records.record(scope: scope)?.result != nil)
    }

    @Test("Background expiration cancels runner, leaves record due, and completes once")
    @MainActor
    func backgroundExpirationLeavesRecordDue() async throws {
        let (records, history) = try await setupStores(scope: scope, location: location)
        let api = HistoryAPI(responses: [historyPage(at: attempt), historyPage(at: attempt)])
        let gate = DetectionGate()
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api,
                                                detect: { _, _, _, _, _ in
                                                    gate.onDetect()
                                                    return self.result(.detected)
                                                }, now: { self.attempt })
        let fakeTask = FakeBackgroundTask()
        var scheduledDue: Date?
        BackgroundSolarLayoutDetection.handleLaunch(
            task: fakeTask, runner: runner, records: records, dueScope: { self.scope },
            reschedule: { scheduledDue = $0 }
        )
        await gate.waitUntilStarted()
        fakeTask.expirationHandler?()
        try await eventually { fakeTask.completedCount == 1 }
        #expect(fakeTask.lastSuccess == false)
        #expect(fakeTask.completedCount == 1)
        #expect(scheduledDue == .distantPast)
        gate.proceed()
        try await staysTrue(for: .milliseconds(50)) { fakeTask.completedCount == 1 }
        let current = try #require(await records.record(scope: scope))
        #expect(current.result == nil)
        #expect(SolarLayoutDetectionSchedule.isDue(current, now: attempt))
    }

    @Test("Background launch with no scope completes once with failure")
    @MainActor
    func backgroundLaunchWithNoScopeCompletes() async throws {
        let (records, history) = try await setupStores(scope: scope)
        let api = HistoryAPI(responses: [])
        let runner = SolarLayoutDetectionRunner(history: history, records: records, api: api, now: { self.attempt })
        let fakeTask = FakeBackgroundTask()
        BackgroundSolarLayoutDetection.handleLaunch(
            task: fakeTask, runner: runner, records: records, dueScope: { nil }
        )
        try await eventually { fakeTask.completedCount == 1 }
        #expect(fakeTask.lastSuccess == false)
        #expect(fakeTask.completedCount == 1)
    }

    private func setupStores(
        scope: SolarForecastSiteScope, location: SolarHomeLocation? = nil
    ) async throws -> (SolarLayoutRecordStore, SolarHistoryStore) {
        let records = SolarLayoutRecordStore(directory: temporaryFolder())
        let history = SolarHistoryStore(directory: temporaryFolder())
        if let location { try await records.setLocation(location, scope: scope, at: attempt) }
        return (records, history)
    }

    private func historyPage(at date: Date) -> MobileSolarHistoryResponse {
        let day = MobileSolarHistoryDay(day: "2026-10-31", dayStart: date, status: .complete,
                                        fetchedAt: date, solarWh: Array(repeating: 0, count: 288))
        return .enabled(timeZone: .gmt, days: [day], nextFrom: nil)
    }

    private func record(
        hasLocation: Bool = true, result: DetectedSolarLayout? = nil,
        version: Int? = nil, attemptedAt: Date? = nil
    ) -> SolarLayoutRecord {
        let loc = hasLocation ? location : nil
        return SolarLayoutRecord(location: loc, locationSetAt: attempt, result: result, detectedAt: attemptedAt,
                                 attemptedAt: attemptedAt, detectorVersion: version, resultLocation: loc)
    }

    private func result(_ status: DetectedSolarLayout.Status) -> DetectedSolarLayout {
        DetectedSolarLayout(status: status, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                            historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
    }

    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}
