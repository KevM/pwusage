import Foundation

enum SolarLayoutDetectionSchedule {
    static func isDue(_ record: SolarLayoutRecord, now: Date) -> Bool {
        guard record.location != nil else { return false }
        guard let result = record.result, record.detectorVersion == SolarLayoutDetector.version else { return true }
        let cadence: TimeInterval = result.status == .detected || result.status == .lowConfidence
            ? 30 * 86_400 : 86_400
        guard let attemptedAt = record.attemptedAt else { return true }
        return now.timeIntervalSince(attemptedAt) >= cadence
    }

    static func nextDue(_ record: SolarLayoutRecord) -> Date? {
        guard record.location != nil else { return nil }
        guard let result = record.result, record.detectorVersion == SolarLayoutDetector.version,
              let attemptedAt = record.attemptedAt else { return .distantPast }
        let cadence: TimeInterval = result.status == .detected || result.status == .lowConfidence
            ? 30 * 86_400 : 86_400
        return attemptedAt.addingTimeInterval(cadence)
    }
}

@MainActor
final class SolarLayoutDetectionRunner {
    typealias Detector = @Sendable (
        [(timestamp: Date, solarWh: Double)], Double, Double, TimeZone, () throws -> Void
    ) throws -> DetectedSolarLayout

    let history: SolarHistoryStore
    let records: SolarLayoutRecordStore
    private let api: any MobileSolarHistoryDataAPI
    private let detect: Detector
    private let now: () -> Date
    private var generation = 0
    private var activeScope: SolarForecastSiteScope?
    private var inFlightSync: (scope: SolarForecastSiteScope, task: Task<SolarHistorySyncResult, Error>)?
    private var detectionTask: Task<DetectedSolarLayout, Error>?
    private var inFlightRun: (scope: SolarForecastSiteScope, task: Task<SolarLayoutRecord?, Never>)?
    var onRecordChanged: ((SolarForecastSiteScope) -> Void)?
    var onRecordSaved: ((SolarForecastSiteScope) -> Void)?
    var onHistoryDisabled: ((SolarForecastSiteScope) -> Void)?

    init(
        history: SolarHistoryStore,
        records: SolarLayoutRecordStore,
        api: any MobileSolarHistoryDataAPI,
        detect: @escaping Detector = SolarLayoutDetector.detect,
        now: @escaping () -> Date = Date.init
    ) {
        self.history = history
        self.records = records
        self.api = api
        self.detect = detect
        self.now = now
    }

    func runIfDue(scope: SolarForecastSiteScope) async -> SolarLayoutRecord? {
        if let current = inFlightRun {
            if current.scope == scope {
                return await current.task.value
            }
            cancel()
        }

        generation += 1
        let run = generation
        activeScope = scope

        let task = Task { @MainActor [weak self] () -> SolarLayoutRecord? in
            guard let self else { return nil }
            return await self.performRunIfDue(scope: scope, run: run)
        }
        inFlightRun = (scope: scope, task: task)

        let result = await task.value
        if inFlightRun?.task == task {
            inFlightRun = nil
            if activeScope == scope {
                activeScope = nil
            }
        }
        return result
    }

    func cancel() {
        generation += 1
        activeScope = nil
        let runToCancel = inFlightRun
        inFlightRun = nil
        inFlightSync?.task.cancel()
        detectionTask?.cancel()
        runToCancel?.task.cancel()
        inFlightSync = nil
        detectionTask = nil
    }

    @discardableResult
    func syncHistory(scope: SolarForecastSiteScope) async -> SolarHistorySyncResult? {
        if let current = inFlightSync, current.scope == scope {
            return (try? await current.task.value)
        }
        let task = Task { try await history.sync(scope: scope, api: api, now: now()) }
        inFlightSync = (scope: scope, task: task)
        defer {
            if inFlightSync?.task == task {
                inFlightSync = nil
            }
        }
        do {
            let result = try await task.value
            if case .disabled = result {
                onHistoryDisabled?(scope)
            }
            return result
        } catch {
            return nil
        }
    }

    private func performRunIfDue(scope: SolarForecastSiteScope, run: Int) async -> SolarLayoutRecord? {
        guard isCurrent(run, scope: scope) else { return nil }

        var resolvedTimeZone: TimeZone?
        let isStale = (try? await history.isSynced(scope: scope, within: 86_400, now: now())) != true
        if isStale {
            guard let zone = await syncHistoryIfCurrent(scope: scope, run: run) else { return nil }
            resolvedTimeZone = zone
        }

        guard let record = try? await records.record(scope: scope),
              isCurrent(run, scope: scope) else {
            return nil
        }
        guard SolarLayoutDetectionSchedule.isDue(record, now: now()),
              let location = record.location else {
            return record
        }

        guard let timeZone = await resolveTimeZone(existing: resolvedTimeZone, scope: scope, run: run),
              let samples = try? await history.samples(scope: scope),
              isCurrent(run, scope: scope) else {
            return nil
        }

        return await executeDetection(
            scope: scope, location: location, timeZone: timeZone, samples: samples, run: run
        )
    }

    private func resolveTimeZone(
        existing: TimeZone?, scope: SolarForecastSiteScope, run: Int
    ) async -> TimeZone? {
        if let existing { return existing }
        if let zone = try? await history.timeZone(scope: scope) { return zone }
        return await syncHistoryIfCurrent(scope: scope, run: run)
    }

    private func executeDetection(
        scope: SolarForecastSiteScope,
        location: SolarHomeLocation,
        timeZone: TimeZone,
        samples: [(timestamp: Date, solarWh: Double)],
        run: Int
    ) async -> SolarLayoutRecord? {
        let operation = Task.detached(priority: .utility) { [detect] in
            try Task.checkCancellation()
            return try detect(
                samples, location.latitude, location.longitude, timeZone, { try Task.checkCancellation() }
            )
        }
        detectionTask = operation
        defer { detectionTask = nil }
        return await saveDetection(operation, scope: scope, location: location, run: run)
    }

    private func syncHistoryIfCurrent(
        scope: SolarForecastSiteScope, run: Int
    ) async -> TimeZone? {
        guard let result = await syncHistory(scope: scope),
              isCurrent(run, scope: scope) else { return nil }
        switch result {
        case .disabled:
            return nil
        case .synced(let zone):
            return zone
        }
    }

    private func saveDetection(
        _ operation: Task<DetectedSolarLayout, Error>,
        scope: SolarForecastSiteScope,
        location: SolarHomeLocation,
        run: Int
    ) async -> SolarLayoutRecord? {
        do {
            let detected = try await operation.value
            guard isCurrent(run, scope: scope) else { return nil }
            guard (try? await records.saveResult(detected, scope: scope, for: location, at: now())) == true else {
                return nil
            }
            let saved = try? await records.record(scope: scope)
            guard isCurrent(run, scope: scope) else { return nil }
            onRecordChanged?(scope)
            onRecordSaved?(scope)
            return saved
        } catch where !(error is CancellationError) {
            guard isCurrent(run, scope: scope) else { return nil }
            guard (try? await records.saveFailure(scope: scope, for: location, at: now())) == true else {
                return nil
            }
            let saved = try? await records.record(scope: scope)
            guard isCurrent(run, scope: scope) else { return nil }
            onRecordChanged?(scope)
            onRecordSaved?(scope)
            return saved
        } catch {
            return nil
        }
    }

    private func isCurrent(_ expected: Int, scope: SolarForecastSiteScope) -> Bool {
        generation == expected && activeScope == scope && !Task.isCancelled
    }
}
