import Foundation
@testable import PWUsage
import Testing

@Suite("Solar History Store energy flows")
struct SolarHistoryStoreFlowsTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let utc = TimeZone(identifier: "UTC") ?? .gmt

    private func store(in folder: URL? = nil) -> SolarHistoryStore {
        let directory = folder ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-tests-\(UUID().uuidString)")
        return SolarHistoryStore(directory: directory)
    }

    private func date(_ iso: String) throws -> Date {
        try #require(ISO8601DateFormatter().date(from: iso))
    }

    private func dayJSON(
        day: String = "2026-10-24",
        start: String = "2026-10-24T00:00:00Z",
        solarCount: Int = 288,
        loadCount: Int = 288,
        gridCount: Int = 288,
        batteryCount: Int = 288,
        socCount: Int = 288
    ) -> String {
        func series(_ count: Int, _ value: String) -> String {
            Array(repeating: value, count: count).joined(separator: ",")
        }
        return """
        {"version":1,"enabled":true,"timeZone":"UTC","days":[{
            "day":"\(day)","dayStart":"\(start)","status":"complete","fetchedAt":"\(start)",
            "solarWh":[\(series(solarCount, "10"))],
            "loadWh":[\(series(loadCount, "20"))],
            "gridWh":[\(series(gridCount, "-5"))],
            "batteryWh":[\(series(batteryCount, "5"))],
            "batterySoc":[\(series(socCount, "50"))]
        }]}
        """
    }

    @Test("Decodes days with load, grid, battery and state-of-charge series")
    func decodesDaysWithFlows() throws {
        let json = dayJSON()
        let response = try MobileContractDecoder.make().decode(
            MobileSolarHistoryResponse.self, from: Data(json.utf8)
        )
        guard case .enabled(let timeZone, let days, _) = response else {
            Issue.record("Expected enabled response")
            return
        }
        #expect(timeZone == utc)
        let first = try #require(days.first)
        #expect(first.solarWh.count == 288)
        #expect(first.loadWh.first == 20)
        #expect(first.gridWh.first == -5)
        #expect(first.batteryWh.first == 5)
        #expect(first.batterySoc.first == 50)
    }

    @Test("Rejects a day whose flow series are not slot-aligned", arguments: [
        (load: 287, grid: 288, battery: 288, soc: 288),
        (load: 288, grid: 289, battery: 288, soc: 288),
        (load: 288, grid: 288, battery: 0, soc: 288),
        (load: 288, grid: 288, battery: 288, soc: 287)
    ])
    func rejectsDayWhoseFlowsAreNotSlotAligned(load: Int, grid: Int, battery: Int, soc: Int) {
        let json = dayJSON(loadCount: load, gridCount: grid, batteryCount: battery, socCount: soc)
        #expect(throws: DecodingError.self) {
            try MobileContractDecoder.make().decode(MobileSolarHistoryResponse.self, from: Data(json.utf8))
        }
    }

    @Test("Merge stores flow series beside solar and returns them from flowDays")
    func mergeStoresFlowsBesideSolar() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-merge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let history = store(in: folder)
        let dayStart = try date("2026-10-24T00:00:00Z")
        let solar: [Double?] = (0 ..< 288).map { Double($0) }
        let load: [Double?] = (0 ..< 288).map { Double($0) + 100 }
        let grid: [Double?] = (0 ..< 288).map { $0.isMultiple(of: 2) ? -12.5 : 8.5 }
        let battery: [Double?] = (0 ..< 288).map { $0 == 0 ? nil : Double($0) - 50 }
        let soc: [Double?] = (0 ..< 288).map { $0 < 10 ? nil : 42.5 }
        let day = MobileSolarHistoryDay(
            day: "2026-10-24", dayStart: dayStart, status: .complete, fetchedAt: dayStart,
            solarWh: solar, loadWh: load, gridWh: grid, batteryWh: battery, batterySoc: soc
        )
        let fill = MobileSolarHistoryFill(timeZone: utc, status: .complete, historyStart: "2026-01-01", days: [day])

        try await history.merge(fill, scope: scope)

        let reloaded = store(in: folder)
        let days = try #require(try await reloaded.flowDays(scope: scope, from: dayStart, to: dayStart))
        #expect(days.count == 1)
        let flow = try #require(days.first)
        #expect(flow.day == "2026-10-24")
        #expect(flow.dayStart == dayStart)
        #expect(flow.solarWh == solar.map { $0.map(Float.init) })
        #expect(flow.loadWh == load.map { $0.map(Float.init) })
        #expect(flow.gridWh == grid.map { $0.map(Float.init) })
        #expect(flow.batteryWh == battery.map { $0.map(Float.init) })
        #expect(flow.batterySoc == soc.map { $0.map(Float.init) })
        #expect(try await reloaded.oldestDayMissingFlows(scope: scope) == nil)
    }

    @Test("Old year file without flows loads, returns nil from flowDays, and reports oldest missing day")
    func oldFileWithoutFlowsLoadsAndReportsMissing() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-legacy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let dayOne = try date("2026-03-01T00:00:00Z")
        let dayTwo = try date("2026-03-02T00:00:00Z")

        try writeLegacyStore(folder: folder, dayStarts: [dayOne, dayTwo])

        let history = store(in: folder)
        #expect(try await history.allStoredDays(scope: scope) == ["2026-03-01", "2026-03-02"])
        #expect(try await history.flowDays(scope: scope, from: dayOne, to: dayTwo) == nil)
        #expect(try await history.oldestDayMissingFlows(scope: scope) == "2026-03-01")
    }

    @Test("flowDays returns nil when any stored day in range lacks flows")
    func flowDaysNilWhenAnyDayInRangeLacksFlows() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-mixed-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let oldDay = try date("2026-03-01T00:00:00Z")
        let newDay = try date("2026-03-02T00:00:00Z")

        try writeLegacyStore(folder: folder, dayStarts: [oldDay])
        let history = store(in: folder)
        let fresh = MobileSolarHistoryDay(
            day: "2026-03-02", dayStart: newDay, status: .complete, fetchedAt: newDay,
            solarWh: Array(repeating: 1, count: 288),
            loadWh: Array(repeating: 2, count: 288),
            gridWh: Array(repeating: 3, count: 288),
            batteryWh: Array(repeating: 4, count: 288),
            batterySoc: Array(repeating: 50, count: 288)
        )
        try await history.merge(
            MobileSolarHistoryFill(timeZone: utc, status: .complete, historyStart: "2026-01-01", days: [fresh]),
            scope: scope
        )

        #expect(try await history.flowDays(scope: scope, from: oldDay, to: newDay) == nil)
        let onlyNew = try #require(try await history.flowDays(scope: scope, from: newDay, to: newDay))
        #expect(onlyNew.map(\.day) == ["2026-03-02"])
        #expect(try await history.oldestDayMissingFlows(scope: scope) == "2026-03-01")
    }

    @Test("Days whose batterySoc is all null are still ready")
    func daysWithStateOfChargeGapsAreReady() async throws {
        let history = store()
        defer { Task { try? await history.removeAll() } }
        let dayStart = try date("2026-10-25T00:00:00Z")
        let day = MobileSolarHistoryDay(
            day: "2026-10-25", dayStart: dayStart, status: .complete, fetchedAt: dayStart,
            solarWh: Array(repeating: 1, count: 288),
            loadWh: Array(repeating: 2, count: 288),
            gridWh: Array(repeating: 3, count: 288),
            batteryWh: Array(repeating: 4, count: 288),
            batterySoc: Array(repeating: nil, count: 288)
        )
        let fill = MobileSolarHistoryFill(timeZone: utc, status: .complete, historyStart: "2026-01-01", days: [day])
        try await history.merge(fill, scope: scope)

        let days = try #require(try await history.flowDays(scope: scope, from: dayStart, to: dayStart))
        #expect(days.count == 1)
        #expect(days.first?.batterySoc.allSatisfy { $0 == nil } == true)
        #expect(try await history.oldestDayMissingFlows(scope: scope) == nil)
    }

    @Test("syncFlows fetches the current billing cycle before backfilling older days")
    func syncFlowsFetchesCurrentCycleFirst() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-sync-order-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let oldDay = try date("2026-03-01T00:00:00Z")
        try writeLegacyStore(folder: folder, dayStarts: [oldDay])
        let history = store(in: folder)
        let now = try date("2026-10-24T12:00:00Z")

        let api = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-10-01")], nextFrom: nil),
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-03-01")], nextFrom: nil)
        ])

        let progress = try await history.syncFlows(
            scope: scope, api: api, cycleStartDay: "2026-10-01", now: now
        )

        #expect(progress == .complete)
        let requests = await api.requests
        #expect(requests.map(\.from) == ["2026-10-01", "2026-03-01"])
        #expect(requests.allSatisfy { $0.changedSince == nil })
        #expect(try await history.oldestDayMissingFlows(scope: scope) == nil)
    }

    @Test("syncFlows resumes from the oldest missing day after an interrupted backfill")
    func syncFlowsResumesFromOldestMissingDay() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-sync-resume-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let dayOne = try date("2026-03-01T00:00:00Z")
        let dayTwo = try date("2026-03-02T00:00:00Z")
        try writeLegacyStore(folder: folder, dayStarts: [dayOne, dayTwo])
        let history = store(in: folder)
        let now = try date("2026-10-24T12:00:00Z")

        let firstAPI = HistoryAPI(
            responses: [
                .enabled(timeZone: utc, days: [try makeFlowDay("2026-10-01")], nextFrom: nil),
                .enabled(timeZone: utc, days: [try makeFlowDay("2026-03-01")], nextFrom: "2026-03-02")
            ],
            failAt: 3
        )
        await #expect(throws: HistoryFailure.injected) {
            try await history.syncFlows(scope: scope, api: firstAPI, cycleStartDay: "2026-10-01", now: now)
        }

        let reloaded = store(in: folder)
        #expect(try await reloaded.oldestDayMissingFlows(scope: scope) == "2026-03-02")

        let secondAPI = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-10-01")], nextFrom: nil),
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-03-02")], nextFrom: nil)
        ])
        let progress = try await reloaded.syncFlows(
            scope: scope, api: secondAPI, cycleStartDay: "2026-10-01", now: now
        )

        #expect(progress == .complete)
        #expect(await secondAPI.requests.map(\.from) == ["2026-10-01", "2026-03-02"])
        #expect(try await reloaded.oldestDayMissingFlows(scope: scope) == nil)
    }

    @Test("syncFlows returns complete when no stored days are missing flows")
    func syncFlowsCompleteWhenNothingMissing() async throws {
        let history = store()
        defer { Task { try? await history.removeAll() } }
        let cycleDay = try makeFlowDay("2026-10-01")
        try await history.merge(
            MobileSolarHistoryFill(timeZone: utc, status: .complete, historyStart: "2026-01-01", days: [cycleDay]),
            scope: scope
        )
        let now = try date("2026-10-24T12:00:00Z")
        let api = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [cycleDay], nextFrom: nil)
        ])

        let progress = try await history.syncFlows(
            scope: scope, api: api, cycleStartDay: "2026-10-01", now: now
        )

        #expect(progress == .complete)
        #expect(await api.requests.map(\.from) == ["2026-10-01"])
    }

    @Test("syncFlows returns partial when a stored day still lacks flows after backfill")
    func syncFlowsPartialWhenDaysRemainMissing() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("flows-sync-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let dayOne = try date("2026-03-01T00:00:00Z")
        let dayTwo = try date("2026-03-02T00:00:00Z")
        try writeLegacyStore(folder: folder, dayStarts: [dayOne, dayTwo])
        let history = store(in: folder)
        let now = try date("2026-10-24T12:00:00Z")

        let api = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-10-01")], nextFrom: nil),
            .enabled(timeZone: utc, days: [try makeFlowDay("2026-03-01")], nextFrom: nil)
        ])

        let progress = try await history.syncFlows(
            scope: scope, api: api, cycleStartDay: "2026-10-01", now: now
        )

        #expect(progress == .partial(oldestMissing: "2026-03-02"))
    }

    private func makeFlowDay(_ day: String) throws -> MobileSolarHistoryDay {
        let start = try date("\(day)T00:00:00Z")
        return MobileSolarHistoryDay(
            day: day, dayStart: start, status: .complete, fetchedAt: start,
            solarWh: Array(repeating: 1, count: 288),
            loadWh: Array(repeating: 2, count: 288),
            gridWh: Array(repeating: 3, count: 288),
            batteryWh: Array(repeating: 4, count: 288),
            batterySoc: Array(repeating: 50, count: 288)
        )
    }

    private func writeLegacyStore(folder: URL, dayStarts: [Date]) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let daysFolder = folder.appendingPathComponent("\(scope.storageHash)-days", isDirectory: true)
        try fileManager.createDirectory(at: daysFolder, withIntermediateDirectories: true)

        var stateData = Data()
        for _ in 0 ..< (dayStarts.count * 288) {
            var bits = Float(10).bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { stateData.append(contentsOf: $0) }
        }
        let yearPayload: [String: Any] = [
            "year": 2026,
            "dayStarts": dayStarts.map(\.timeIntervalSinceReferenceDate),
            "counts": Array(repeating: 288, count: dayStarts.count),
            "slots": stateData.base64EncodedString()
        ]
        try JSONSerialization.data(withJSONObject: yearPayload)
            .write(to: daysFolder.appendingPathComponent("2026.json"))

        let sitePayload: [String: Any] = [
            "timeZone": "UTC",
            "isEnabled": true
        ]
        try JSONSerialization.data(withJSONObject: sitePayload)
            .write(to: folder.appendingPathComponent("\(scope.storageHash).json"))
    }
}
