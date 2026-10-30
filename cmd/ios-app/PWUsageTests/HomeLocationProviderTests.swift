import CoreLocation
import Foundation
@testable import PWUsage
import Testing

@MainActor
final class FakeHomeLocationManager: HomeLocationManaging {
    var authorizationStatus: CLAuthorizationStatus
    weak var events: (any HomeLocationEvents)?
    private(set) var authorizationRequests = 0
    private(set) var locationRequests = 0
    private(set) var stops = 0
    /// What a location request answers with, if anything; `nil` leaves it hanging.
    var answer: Result<[CLLocation], any Error>?
    /// The status the user picks when asked.
    var grantedStatus: CLAuthorizationStatus = .authorizedWhenInUse

    init(status: CLAuthorizationStatus) { authorizationStatus = status }

    func requestWhenInUseAuthorization() {
        authorizationRequests += 1
        authorizationStatus = grantedStatus
        events?.authorizationChanged(grantedStatus)
    }

    func requestLocation() {
        locationRequests += 1
        switch answer {
        case .success(let locations): events?.received(locations)
        case .failure(let error): events?.failed(error)
        case nil: break
        }
    }

    func stop() { stops += 1 }
}

@MainActor
@Suite("Home location provider")
struct HomeLocationProviderTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    private static func fix(
        _ latitude: Double, _ longitude: Double, accuracy: Double = 30, age: TimeInterval = 5
    ) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude), altitude: 0,
            horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: now.addingTimeInterval(-age)
        )
    }

    private static func provider(
        _ manager: FakeHomeLocationManager,
        timeout: @escaping @MainActor (TimeInterval) async -> Void = { _ in
            await Task.yield(); try? await Task.sleep(for: .seconds(60)) }
    ) -> DeviceHomeLocationProvider {
        DeviceHomeLocationProvider(manager: manager, now: { now }, timeout: timeout)
    }

    @Test("A fix is rounded to two decimals before it leaves the device")
    func rounding() async throws {
        let manager = FakeHomeLocationManager(status: .authorizedWhenInUse)
        manager.answer = .success([Self.fix(43.39321, -87.87154)])
        let location = try await Self.provider(manager).currentRoundedLocation()
        #expect(location == SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device))
        #expect(manager.locationRequests == 1)
    }

    @Test("Permission is asked for once, only when undetermined")
    func asksWhenUndetermined() async throws {
        let manager = FakeHomeLocationManager(status: .notDetermined)
        manager.answer = .success([Self.fix(1.234, 5.678)])
        _ = try await Self.provider(manager).currentRoundedLocation()
        #expect(manager.authorizationRequests == 1)
    }

    @Test("Denied and restricted permission end without a request", arguments: [
        (CLAuthorizationStatus.denied, HomeLocationError.denied),
        (.restricted, .restricted)
    ])
    func refused(status: CLAuthorizationStatus, expected: HomeLocationError) async {
        let manager = FakeHomeLocationManager(status: status)
        await #expect(throws: expected) { try await Self.provider(manager).currentRoundedLocation() }
        #expect(manager.locationRequests == 0)
        let asked = FakeHomeLocationManager(status: .notDetermined)
        asked.grantedStatus = status
        await #expect(throws: expected) { try await Self.provider(asked).currentRoundedLocation() }
    }

    @Test("Stale, inaccurate or failed fixes are unavailable")
    func unusableFixes() async {
        let answers: [Result<[CLLocation], any Error>] = [
            .success([Self.fix(1, 2, age: 61)]),
            .success([Self.fix(1, 2, accuracy: 1500)]),
            .success([Self.fix(1, 2, accuracy: -1)]),
            .success([]),
            .failure(CLError(.locationUnknown))
        ]
        for answer in answers {
            let manager = FakeHomeLocationManager(status: .authorizedWhenInUse)
            manager.answer = answer
            await #expect(throws: HomeLocationError.unavailable) {
                try await Self.provider(manager).currentRoundedLocation()
            }
            #expect(manager.stops == 1)
        }
    }

    @Test("A request that never answers times out once")
    func timeout() async {
        let manager = FakeHomeLocationManager(status: .authorizedWhenInUse)
        let provider = Self.provider(manager, timeout: { _ in })
        await #expect(throws: HomeLocationError.unavailable) { try await provider.currentRoundedLocation() }
        #expect(manager.stops == 1)
    }

    @Test("Cancellation ends the request and resumes once")
    func cancellation() async {
        let manager = FakeHomeLocationManager(status: .authorizedWhenInUse)
        let provider = Self.provider(manager)
        let task = Task { try await provider.currentRoundedLocation() }
        while manager.locationRequests == 0 { await Task.yield() }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(manager.stops == 1)
    }
}
