import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar health model")
struct SolarHealthModelTests {
    private actor ResultBox {
        var value: SolarHealthResult
        init(_ value: SolarHealthResult) { self.value = value }
        func set(_ next: SolarHealthResult) { value = next }
    }

    private actor RunGate {
        private var continuations: [CheckedContinuation<Void, Never>] = []
        private var started = 0

        func waitForRun() async -> Int {
            started += 1
            let index = started
            await withCheckedContinuation { continuations.append($0) }
            return index
        }

        func count() -> Int { started }

        func resume(index: Int) {
            guard index < continuations.count else { return }
            continuations[index].resume()
        }
    }

    private static func makeResult(reference: SolarHealthReference, ratios: [SolarDailyRatio]) -> SolarHealthResult {
        let year = SolarHealthYear(
            year: 2026, key: "k-\(ratios.count)", clearDays: 10,
            capacity: SolarHealthCapacity(
                site: 0.94, directions: [.init(azimuth: 180, factor: 0.94)], clearDays: 10),
            months: [], shade: [], dailyRatios: ratios)
        return SolarHealthResult(
            reference: reference, years: [year], referenceScale: 1.0, recomputedYears: [2026])
    }

    @Test("Marks unread findings until seen and refreshes on reactivate")
    func unreadFindingLifecycle() async throws {
        let suiteName = "solar-health-model-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(suiteName)
        defer { try? FileManager.default.removeItem(at: dir) }

        let records = SolarLayoutRecordStore(directory: dir.appendingPathComponent("records"))
        let scope = SolarForecastSiteScope(accountScopeID: "acct", siteID: "site-1")
        let manual = manualLayout(for: [SolarHealthPlane.face(180, tilt: 25, kw: 5)])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let location = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device)
        try await records.setLocation(location, scope: scope)
        try await records.setManualLayout(manual, scope: scope)

        let faultRatios: [SolarDailyRatio] = (1 ... 10).map { day in
            let ratio = day <= 6 ? 1.0 : 0.85
            return SolarDailyRatio(
                day: String(format: "2026-04-%02d", day), ratio: ratio, expectedKwh: 30, actualKwh: 30 * ratio)
        }
        let box = ResultBox(Self.makeResult(reference: reference, ratios: faultRatios))
        let model = SolarHealthModel(
            history: SolarHistoryStore(directory: dir.appendingPathComponent("history")),
            records: records,
            cache: SolarHealthCache(directory: dir.appendingPathComponent("cache")),
            defaults: defaults,
            runner: { _, _, _, _, _ in await box.value })
        model.activate(scope: scope)

        try await eventually(timeout: .seconds(5)) { model.report != nil && !model.isRunning }
        #expect(model.hasUnreadFinding)

        model.markFindingsSeen()
        #expect(!model.hasUnreadFinding)

        await box.set(Self.makeResult(
            reference: reference,
            ratios: [SolarDailyRatio(day: "2026-04-10", ratio: 1.0, expectedKwh: 30, actualKwh: 30)]))
        model.activate(scope: scope)

        try await eventually(timeout: .seconds(5)) {
            model.report?.visibleFindings.isEmpty == true && !model.isRunning
        }
        #expect(!model.hasUnreadFinding)
    }

    @Test("Superseded reload does not clear replacement task running state")
    func supersededReloadPreservesRunningState() async throws {
        let suiteName = "solar-health-model-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(suiteName)
        defer { try? FileManager.default.removeItem(at: dir) }

        let records = SolarLayoutRecordStore(directory: dir.appendingPathComponent("records"))
        let scope = SolarForecastSiteScope(accountScopeID: "acc", siteID: "site-1")
        let manual = manualLayout(for: [SolarHealthPlane.face(180, tilt: 25, kw: 5)])
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let location = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device)
        try await records.setLocation(location, scope: scope)
        try await records.setManualLayout(manual, scope: scope)

        let gate = RunGate()
        var startedCount = 0
        let firstResult = Self.makeResult(reference: reference, ratios: [])
        let secondResult = Self.makeResult(
            reference: reference,
            ratios: [SolarDailyRatio(day: "2026-04-10", ratio: 1.0, expectedKwh: 30, actualKwh: 30)])

        let model = SolarHealthModel(
            records: records,
            cache: SolarHealthCache(directory: dir.appendingPathComponent("cache")),
            defaults: defaults,
            runner: { _, _, _, _, _ in
                await MainActor.run { startedCount += 1 }
                let index = await gate.waitForRun()
                return index == 1 ? firstResult : secondResult
            })

        model.activate(scope: scope)
        try await eventually(timeout: .seconds(5)) { startedCount == 1 }

        model.reload()
        try await eventually(timeout: .seconds(5)) { startedCount == 2 }

        await gate.resume(index: 0)
        try await staysTrue(for: .milliseconds(50)) {
            model.isRunning && model.report == nil
        }

        await gate.resume(index: 1)
        try await eventually(timeout: .seconds(5)) {
            model.report?.potentialVsActual?.day == "2026-04-10" && !model.isRunning
        }
    }
}
