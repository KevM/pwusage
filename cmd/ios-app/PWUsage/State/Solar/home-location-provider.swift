import CoreLocation
import Foundation

enum HomeLocationError: Error, Equatable {
    case denied
    case restricted
    case unavailable
}

@MainActor
protocol HomeLocationProviding: AnyObject {
    /// One When-In-Use fix, rounded to two decimals (~1 km) before it leaves this call.
    func currentRoundedLocation() async throws -> SolarHomeLocation
}

@MainActor
protocol HomeLocationEvents: AnyObject {
    func authorizationChanged(_ status: CLAuthorizationStatus)
    func received(_ locations: [CLLocation])
    func failed(_ error: any Error)
}

/// The slice of `CLLocationManager` the provider uses, so tests can drive it.
@MainActor
protocol HomeLocationManaging: AnyObject {
    var authorizationStatus: CLAuthorizationStatus { get }
    var events: (any HomeLocationEvents)? { get set }
    func requestWhenInUseAuthorization()
    func requestLocation()
    func stop()
}

/// Asks for one fix, in the foreground, only when called. Never in the background and never
/// again on its own: the caller decides when to ask, after the user confirms they are home.
@MainActor
final class DeviceHomeLocationProvider: HomeLocationProviding, HomeLocationEvents {
    static let timeout: TimeInterval = 30
    static let maximumFixAge: TimeInterval = 60
    static let maximumAccuracy: CLLocationAccuracy = 1000

    private let manager: any HomeLocationManaging
    private let now: () -> Date
    private let timeout: @MainActor (TimeInterval) async -> Void
    private var authorization: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var fix: CheckedContinuation<SolarHomeLocation, any Error>?

    init(
        manager: (any HomeLocationManaging)? = nil,
        now: @escaping () -> Date = Date.init,
        timeout: @escaping @MainActor (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.manager = manager ?? CoreLocationHomeManager()
        self.now = now
        self.timeout = timeout
        self.manager.events = self
    }

    func currentRoundedLocation() async throws -> SolarHomeLocation {
        var status = manager.authorizationStatus
        if status == .notDetermined {
            status = await withCheckedContinuation { continuation in
                authorization = continuation
                manager.requestWhenInUseAuthorization()
            }
        }
        switch status {
        case .denied: throw HomeLocationError.denied
        case .restricted: throw HomeLocationError.restricted
        case .authorizedWhenInUse, .authorizedAlways: break
        default: throw HomeLocationError.unavailable
        }
        try Task.checkCancellation()
        let timer = Task { [timeout] in
            await timeout(Self.timeout)
            guard !Task.isCancelled else { return }
            self.finish(.failure(HomeLocationError.unavailable))
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                fix = continuation
                manager.requestLocation()
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    func authorizationChanged(_ status: CLAuthorizationStatus) {
        guard status != .notDetermined, let authorization else { return }
        self.authorization = nil
        authorization.resume(returning: status)
    }

    func received(_ locations: [CLLocation]) {
        guard let location = locations.last, isUsable(location) else {
            finish(.failure(HomeLocationError.unavailable))
            return
        }
        finish(.success(SolarHomeLocation(
            latitude: location.coordinate.latitude.roundedToHundredths,
            longitude: location.coordinate.longitude.roundedToHundredths,
            source: .device
        )))
    }

    func failed(_ error: any Error) {
        finish(.failure(HomeLocationError.unavailable))
    }

    private func isUsable(_ location: CLLocation) -> Bool {
        let age = now().timeIntervalSince(location.timestamp)
        return age.isFinite && age <= Self.maximumFixAge && location.horizontalAccuracy >= 0
            && location.horizontalAccuracy <= Self.maximumAccuracy && CLLocationCoordinate2DIsValid(location.coordinate)
    }

    /// Resumes the pending request exactly once and stops delegate work.
    private func finish(_ result: Result<SolarHomeLocation, any Error>) {
        guard let fix else { return }
        self.fix = nil
        manager.stop()
        fix.resume(with: result)
    }
}

@MainActor
final class CoreLocationHomeManager: NSObject, HomeLocationManaging, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    weak var events: (any HomeLocationEvents)?

    override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.delegate = self
    }

    var authorizationStatus: CLAuthorizationStatus { manager.authorizationStatus }
    func requestWhenInUseAuthorization() { manager.requestWhenInUseAuthorization() }
    func requestLocation() { manager.requestLocation() }
    func stop() { manager.stopUpdatingLocation() }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        events?.authorizationChanged(manager.authorizationStatus)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        events?.received(locations)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        events?.failed(error)
    }
}
