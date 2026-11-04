import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Battery hold Live Activity lifecycle", .serialized, .timeLimit(.minutes(1)))
struct BatteryHoldActivityCoordinatorTests {
    let host = FakeActivityHost()
    let api = FakeActivityAPI()
    let defaults = UserDefaults(suiteName: "activity-tests-\(UUID().uuidString)") ?? .standard
    let start = Date(timeIntervalSinceReferenceDate: 813751200)

    func makeCoordinator(environment: ApnsEnvironment? = .sandbox,
                         signOutTimeout: Duration = .seconds(3)) -> BatteryHoldActivityCoordinator {
        let coordinator = BatteryHoldActivityCoordinator(
            host: host, api: api, apnsEnvironment: environment,
            store: BatteryHoldActivityRegistrationStore(defaults: defaults),
            now: { [start] in start.addingTimeInterval(600) }, sleep: { _ in },
            signOutTimeout: signOutTimeout
        )
        coordinator.sitesAuthorized([MobileSite(id: "site-1", name: "Home", utility: "PGE"),
                                     MobileSite(id: "site-2", name: "Cabin", utility: "PGE")])
        return coordinator
    }

    func hold(id: Int = 7, site: String = "site-1", mode: BatteryHoldMode = .auto,
              checkedAt: TimeInterval? = nil, hours: Double = 8) -> BatteryHold {
        var hold = BatteryHold(id: id, siteID: site, status: .active, mode: mode,
                               originalReserve: 20, targetReserve: 100,
                               createdAt: start, safetyExpiresAt: start.addingTimeInterval(hours * 3600),
                               cancelledObservedReserve: nil)
        if let checkedAt {
            hold.monitoring = .init(phase: .watching, checkedAt: start.addingTimeInterval(checkedAt),
                                    nextCheckAt: start.addingTimeInterval(checkedAt + 900),
                                    sampledAt: nil, estimatedLoadW: nil)
        }
        return hold
    }

    func started(_ coordinator: BatteryHoldActivityCoordinator,
                 _ hold: BatteryHold) async throws -> FakeActivityHandle {
        coordinator.batteryHoldConfirmed(.started(hold), siteID: hold.siteID, timeZone: "America/Los_Angeles")
        try await eventually { host.handles.contains { $0.attributes.holdID == hold.id } }
        return try #require(host.handles.last)
    }

    @Test("A confirmed start requests one token-push activity with the site and hold")
    func startsOnce() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        #expect(handle.attributes.siteID == "site-1")
        #expect(handle.attributes.siteName == "Home")
        #expect(handle.attributes.timeZoneIdentifier == "America/Los_Angeles")
        #expect(handle.state == .init(hold: hold()))
        // A duplicate start (already_active, a second tap) reuses the activity.
        coordinator.batteryHoldConfirmed(.started(hold(checkedAt: 300)), siteID: "site-1", timeZone: nil)
        try await eventually { handle.updates.count == 1 }
        #expect(host.handles.count == 1)
        #expect(handle.state.checkedAt == start.addingTimeInterval(300))
        #expect(coordinator.offer(forHoldID: 7) == .showing)
    }

    @Test("Denied or failing Live Activities never throw into the hold")
    func deniedActivities() async throws {
        host.activitiesEnabled = false
        let coordinator = makeCoordinator()
        coordinator.batteryHoldConfirmed(.started(hold()), siteID: "site-1", timeZone: nil)
        try await eventually { coordinator.offer(forHoldID: 7) == .disabled }
        try await staysTrue { host.handles.isEmpty }
        host.activitiesEnabled = true
        host.startError = URLError(.unknown)
        coordinator.batteryHoldConfirmed(.started(hold()), siteID: "site-1", timeZone: nil)
        try await eventually { coordinator.offer(forHoldID: 7) == .available }
        try await staysTrue { host.handles.isEmpty }
    }

    @Test("Each push token is registered with its true environment; rotation re-registers")
    func registersTokens() async throws {
        let coordinator = makeCoordinator(environment: .production)
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data([0xAB, 0x01] + Array(repeating: 0, count: 30)))
        try await eventually { api.registrations.count == 1 }
        let first = try #require(api.registrations.first)
        #expect(first.siteID == "site-1")
        #expect(first.registration.holdId == 7)
        #expect(first.registration.registrationId == handle.attributes.registrationID.uuidString.lowercased())
        #expect(first.registration.pushToken.hasPrefix("ab01"))
        #expect(first.registration.pushToken.count == 64)
        #expect(first.registration.apnsEnvironment == .production)
        // The same token again is not re-sent; a rotated one is.
        handle.emit(token: Data([0xAB, 0x01] + Array(repeating: 0, count: 30)))
        handle.emit(token: Data(repeating: 0xCD, count: 32))
        try await eventually { api.registrations.count == 2 }
        try await staysTrue { api.registrations.count == 2 }
        #expect(api.registrations.last?.registration.pushToken.hasPrefix("cdcd") == true)
    }

    @Test("A build without an APNs environment shows the activity but never registers")
    func noEnvironment() async throws {
        let coordinator = makeCoordinator(environment: nil)
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await staysTrue { api.registrations.isEmpty }
    }

    @Test("Temporary registration failures retry; rejections stop")
    func retries() async throws {
        let coordinator = makeCoordinator()
        api.registerErrors = [PWUsageAPIError.recoverableServerError(statusCode: 503), URLError(.timedOut)]
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.registerAttempts == 3 }
        #expect(api.registrations.count == 1)

        api.registerErrors = [PWUsageAPIError.requestRejected(statusCode: 429, message: "registration_limit")]
        handle.emit(token: Data(repeating: 2, count: 32))
        try await eventually { api.registerAttempts == 4 }
        try await staysTrue { api.registerAttempts == 4 }
        #expect(handle.lifecycle == .active)
    }

    @Test("Losing site access ends the activity immediately and unregisters it")
    func accessLost() async throws {
        let coordinator = makeCoordinator()
        api.registerErrors = [PWUsageAPIError.requestRejected(statusCode: 403, message: "Unauthorized")]
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { handle.ends.count == 1 }
        #expect(handle.ends.first?.immediately == true)
        try await eventually { api.removals.count == 1 }
        #expect(api.removals.first?.registrationID == handle.attributes.registrationID)
    }
}

@MainActor
final class FakeActivityHandle: BatteryHoldActivityHandle {
    struct End { let state: BatteryHoldActivityAttributes.ContentState?; let immediately: Bool }
    let id = UUID().uuidString
    let attributes: BatteryHoldActivityAttributes
    var state: BatteryHoldActivityAttributes.ContentState
    var lifecycle: BatteryHoldActivityLifecycle = .active
    var pushToken: Data?
    var updates: [BatteryHoldActivityAttributes.ContentState] = []
    var ends: [End] = []
    // Fan out to every observer, as ActivityKit's sequences do for each caller.
    private var tokenObservers: [AsyncStream<Data>.Continuation] = []
    private var lifecycleObservers: [AsyncStream<BatteryHoldActivityLifecycle>.Continuation] = []

    init(attributes: BatteryHoldActivityAttributes, state: BatteryHoldActivityAttributes.ContentState) {
        self.attributes = attributes
        self.state = state
    }

    func pushTokenUpdates() -> AsyncStream<Data> {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        tokenObservers.append(continuation)
        return stream
    }
    func lifecycleUpdates() -> AsyncStream<BatteryHoldActivityLifecycle> {
        let (stream, continuation) = AsyncStream<BatteryHoldActivityLifecycle>.makeStream()
        lifecycleObservers.append(continuation)
        return stream
    }
    func update(_ state: BatteryHoldActivityAttributes.ContentState) async {
        self.state = state
        updates.append(state)
    }
    func end(_ state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool) async {
        if let state { self.state = state }
        ends.append(End(state: state, immediately: immediately))
        set(immediately ? .dismissed : .ended)
    }
    func emit(token: Data) {
        pushToken = token
        tokenObservers.forEach { $0.yield(token) }
    }
    func dismiss() { set(.dismissed) }
    private func set(_ value: BatteryHoldActivityLifecycle) {
        lifecycle = value
        lifecycleObservers.forEach { $0.yield(value) }
    }
}

@MainActor
final class FakeActivityHost: BatteryHoldActivityHost {
    var activitiesEnabled = true
    var startError: (any Error)?
    var handles: [FakeActivityHandle] = []

    func activities() -> [any BatteryHoldActivityHandle] { handles }
    func start(attributes: BatteryHoldActivityAttributes,
               state: BatteryHoldActivityAttributes.ContentState) throws -> any BatteryHoldActivityHandle {
        if let startError { throw startError }
        let handle = FakeActivityHandle(attributes: attributes, state: state)
        handles.append(handle)
        return handle
    }
}

@MainActor
final class FakeActivityAPI: BatteryHoldActivityAPI {
    struct Registered { let siteID: String; let registration: BatteryHoldActivityRegistration }
    struct Removed { let siteID: String; let registrationID: UUID }
    var registrations: [Registered] = []
    /// Completed calls in order.
    var events: [String] = []
    var removals: [Removed] = []
    var registerAttempts = 0
    var registerErrors: [any Error] = []
    var holdResponses: [String: BatteryHoldResponse] = [:]
    var pauseRegistration = false
    private(set) var isPaused = false
    private(set) var cancelledRegistrations = 0
    var pauseFetch = false
    private(set) var isFetchPaused = false

    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse {
        // The answer as of when the read began, as a real request would have it.
        let response = holdResponses[siteID]
        if pauseFetch {
            pauseFetch = false
            isFetchPaused = true
            while isFetchPaused { try await Task.sleep(for: .milliseconds(2)) }
        }
        guard let response else { throw URLError(.notConnectedToInternet) }
        return response
    }
    func registerBatteryHoldActivity(siteID: String, registration: BatteryHoldActivityRegistration) async throws {
        registerAttempts += 1
        if pauseRegistration {
            pauseRegistration = false
            isPaused = true
            // Like URLSession, a paused request gives up when its task is cancelled.
            do {
                while isPaused { try await Task.sleep(for: .milliseconds(2)) }
            } catch {
                cancelledRegistrations += 1
                throw error
            }
        }
        if !registerErrors.isEmpty { throw registerErrors.removeFirst() }
        registrations.append(.init(siteID: siteID, registration: registration))
        events.append("register")
    }
    func unregisterBatteryHoldActivity(siteID: String, registrationID: UUID) async throws {
        removals.append(.init(siteID: siteID, registrationID: registrationID))
        events.append("remove")
    }
    func resume() { isPaused = false }
    func resumeFetch() { isFetchPaused = false }
}

@MainActor
final class Flag { var value = false }
