import BackgroundTasks
import Foundation
import os
import OSLog

protocol BackgroundLayoutDetectingTask: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func setTaskCompleted(success: Bool)
}

extension BGProcessingTask: BackgroundLayoutDetectingTask {}

@MainActor
enum BackgroundSolarLayoutDetection {
    static let identifier = "fm.rodeo.pwusage.solar-layout-detect"
    private static var runner: SolarLayoutDetectionRunner?
    private static var dueScope: (@Sendable () async -> SolarForecastSiteScope?)?

    @MainActor
    static func defaultScope(userDefaults: UserDefaults = .standard) -> SolarForecastSiteScope? {
        guard let account = userDefaults.string(forKey: PWUsageAppModel.accountScopeDefaultsKey),
              let site = userDefaults.string(forKey: PWUsageAppModel.selectedSiteDefaultsKey),
              !account.isEmpty, !site.isEmpty else {
            return nil
        }
        return SolarForecastSiteScope(accountScopeID: account, siteID: site)
    }

    static func configure(
        runner: SolarLayoutDetectionRunner,
        dueScope: (@Sendable () async -> SolarForecastSiteScope?)? = nil
    ) {
        self.runner = runner
        self.dueScope = dueScope ?? { @MainActor in defaultScope() }
        runner.onRecordSaved = { [weak runner] scope in
            guard let runner else { return }
            Task {
                let record = try? await runner.records.record(scope: scope)
                schedule(nextDue: record.flatMap(SolarLayoutDetectionSchedule.nextDue))
            }
        }
    }

    static func request(nextDue: Date) -> BGProcessingTaskRequest {
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = nextDue
        return request
    }

    static func schedule(nextDue: Date?) {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        guard let nextDue else { return }
        do {
            try BGTaskScheduler.shared.submit(request(nextDue: nextDue))
        } catch {
            Logger(subsystem: "fm.rodeo.pwusage", category: "solar-background")
                .debug("Background layout detection could not be scheduled")
        }
    }

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            guard let task = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            if runner == nil, let api = try? BackgroundSolarForecastRefresh.api() {
                let detected = SolarLayoutDetectionRunner(history: .shared, records: .shared, api: api)
                configure(runner: detected)
            }
            guard let runner, let dueScope else {
                task.setTaskCompleted(success: false)
                return
            }
            handleLaunch(task: task, runner: runner, records: runner.records, dueScope: dueScope)
        }
    }

    @discardableResult
    static func handleLaunch(
        task: any BackgroundLayoutDetectingTask,
        runner: SolarLayoutDetectionRunner,
        records: SolarLayoutRecordStore,
        dueScope: @escaping @Sendable () async -> SolarForecastSiteScope?,
        reschedule: @escaping (Date?) -> Void = { schedule(nextDue: $0) }
    ) -> Task<Void, Never> {
        let gate = CompletionGate(task: task)
        let work = Task { @MainActor in
            guard let scope = await dueScope() else {
                gate.complete(false)
                return
            }
            let record = await runner.runIfDue(scope: scope)
            let reRead = try? await records.record(scope: scope)
            reschedule(reRead.flatMap(SolarLayoutDetectionSchedule.nextDue))
            gate.complete(record != nil)
        }
        task.expirationHandler = {
            Task { @MainActor in
                runner.cancel()
                work.cancel()
                if let scope = await dueScope() {
                    let reRead = try? await records.record(scope: scope)
                    reschedule(reRead.flatMap(SolarLayoutDetectionSchedule.nextDue))
                }
                gate.complete(false)
            }
        }
        return work
    }

    @MainActor
    static func scheduleSelectedRecordIfDue() async {
        guard let dueScope, let scope = await dueScope() else { return }
        let store = runner?.records ?? .shared
        guard let record = try? await store.record(scope: scope),
              SolarLayoutDetectionSchedule.isDue(record, now: Date()) else { return }
        schedule(nextDue: SolarLayoutDetectionSchedule.nextDue(record))
    }

    @MainActor
    static func schedule(scope: SolarForecastSiteScope) async {
        let store = runner?.records ?? .shared
        guard let record = try? await store.record(scope: scope),
              SolarLayoutDetectionSchedule.isDue(record, now: Date()) else { return }
        schedule(nextDue: SolarLayoutDetectionSchedule.nextDue(record))
    }
}

final class CompletionGate: @unchecked Sendable {
    private let isCompleted = OSAllocatedUnfairLock(initialState: false)
    private let task: any BackgroundLayoutDetectingTask

    init(task: any BackgroundLayoutDetectingTask) {
        self.task = task
    }

    func complete(_ success: Bool) {
        let shouldComplete = isCompleted.withLock { completed -> Bool in
            if completed { return false }
            completed = true
            return true
        }
        guard shouldComplete else { return }
        task.setTaskCompleted(success: success)
    }
}
