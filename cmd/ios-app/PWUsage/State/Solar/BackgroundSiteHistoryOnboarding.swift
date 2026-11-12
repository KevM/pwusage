import BackgroundTasks
import Foundation
import OSLog

/// Background opportunities for history onboarding. A processing task, because one slice can
/// keep the server importing for about fifteen seconds and a run asks for several; iOS decides
/// whether and when it runs, and expiration cancels with confirmed progress already saved.
@MainActor
enum BackgroundSiteHistoryOnboarding {
    static let identifier = "fm.rodeo.pwusage.history-onboarding"
    private static var lifecycle: SiteHistoryOnboardingLifecycle?
    private static var dueScope: (@MainActor () -> SolarForecastSiteScope?) = {
        BackgroundSolarLayoutDetection.defaultScope()
    }

    static func configure(
        lifecycle: SiteHistoryOnboardingLifecycle,
        dueScope: (@MainActor () -> SolarForecastSiteScope?)? = nil
    ) {
        self.lifecycle = lifecycle
        if let dueScope { self.dueScope = dueScope }
    }

    static func request(earliest: Date) -> BGProcessingTaskRequest {
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = earliest
        return request
    }

    private static let logger = Logger(subsystem: "fm.rodeo.pwusage", category: "solar-background")

    /// Replaces any pending request; nil leaves none.
    static func schedule(earliest: Date?) {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        guard let earliest else {
            logger.info("Background history: nothing to schedule")
            return
        }
        do {
            try BGTaskScheduler.shared.submit(request(earliest: earliest))
            logger.info("Background history: scheduled, not before \(earliest.formatted(), privacy: .public)")
        } catch {
            logger.error("Background history could not be scheduled: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// When iOS may first run the pending request; nil when none is pending.
    static func pendingEarliest() async -> Date? {
        await BGTaskScheduler.shared.pendingTaskRequests().first { $0.identifier == identifier }?.earliestBeginDate
    }

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            guard let task = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            if lifecycle == nil, let api = try? BackgroundSiteHistoryOnboarding.api() {
                let runner = SolarLayoutDetectionRunner(history: .shared, records: .shared, api: api)
                configure(lifecycle: .live(api: api, runner: runner))
            }
            guard let lifecycle else {
                task.setTaskCompleted(success: false)
                return
            }
            handleLaunch(task: task, lifecycle: lifecycle, dueScope: dueScope)
        }
    }

    @discardableResult
    static func handleLaunch(
        task: any BackgroundLayoutDetectingTask,
        lifecycle: SiteHistoryOnboardingLifecycle,
        dueScope: @escaping @MainActor () -> SolarForecastSiteScope?,
        reschedule: @escaping @MainActor (Date?) -> Void = { schedule(earliest: $0) }
    ) -> Task<Void, Never> {
        let gate = CompletionGate(task: task)
        let work = Task { @MainActor in
            guard let scope = dueScope() else {
                reschedule(nil)
                gate.complete(false)
                return
            }
            logger.info("Background history: opportunity granted")
            let next = await lifecycle.runInBackground(scope: scope)
            logger.info("Background history: run ended, next \(next?.formatted() ?? "none", privacy: .public)")
            guard !Task.isCancelled else { return }
            reschedule(next)
            gate.complete(true)
        }
        task.expirationHandler = {
            Task { @MainActor in
                work.cancel()
                if let scope = dueScope() { reschedule(await lifecycle.nextOpportunity(scope: scope)) }
                gate.complete(false)
            }
        }
        return work
    }

    /// The background client, with room for a fill's server-side import (the shared session's
    /// 20-second timeout suits ordinary reads).
    static func api() throws -> PWUsageAPI {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = SharedWebSession.cookieStorage()
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.allowsConstrainedNetworkAccess = false
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 55
        return try PWUsageAPI(
            configuration: AppConfiguration.fromBundle(), session: URLSession(configuration: configuration)
        )
    }
}
