import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar health model")
struct SolarHealthModelTests {
    @Test("Marks unread findings until seen for the site")
    func unreadFindingLifecycle() async throws {
        let suiteName = "solar-health-model-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(suiteName)
        defer { try? FileManager.default.removeItem(at: dir) }

        let history = SolarHistoryStore(directory: dir.appendingPathComponent("history"))
        let records = SolarLayoutRecordStore(directory: dir.appendingPathComponent("records"))
        let cache = SolarHealthCache(directory: dir.appendingPathComponent("cache"))
        let scope = SolarForecastSiteScope(accountScopeID: "acct", siteID: "site-1")

        let planes = [SolarHealthPlane.face(180, tilt: 25, kw: 5)]
        let manual = manualLayout(for: planes)
        let reference = try #require(SolarHealthReference(manual: manual, detected: nil))
        let location = SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device)
        try await records.setLocation(location, scope: scope)
        try await records.setManualLayout(manual, scope: scope)

        let ratios: [SolarDailyRatio] = (1 ... 10).map { day in
            let ratio = day <= 6 ? 1.0 : 0.85
            return SolarDailyRatio(
                day: String(format: "2026-04-%02d", day),
                ratio: ratio,
                expectedKwh: 30,
                actualKwh: 30 * ratio)
        }
        let year = SolarHealthYear(
            year: 2026, key: "k", clearDays: 10,
            capacity: SolarHealthCapacity(
                site: 0.94, directions: [.init(azimuth: 180, factor: 0.94)], clearDays: 10),
            months: [], shade: [], dailyRatios: ratios)
        let stubResult = SolarHealthResult(
            reference: reference, years: [year], referenceScale: 1.0, recomputedYears: [2026])

        let model = SolarHealthModel(
            history: history, records: records, cache: cache, defaults: defaults,
            runner: { _, _, _, _, _ in stubResult })
        model.activate(scope: scope)

        try await eventually(timeout: .seconds(5)) {
            model.report != nil && !model.isRunning
        }

        let report = try #require(model.report)
        #expect(!report.visibleFindings.isEmpty)
        #expect(model.hasUnreadFinding)

        model.markFindingsSeen()
        #expect(!model.hasUnreadFinding)
    }
}
