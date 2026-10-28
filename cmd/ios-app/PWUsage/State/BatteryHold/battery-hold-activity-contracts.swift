import CryptoKit
import Foundation
import Observation
import os
import OSLog

/// The APNs environment a build's `aps-environment` entitlement selects. The
/// server keeps sandbox and production registrations apart and accepts
/// production only from the production deployment.
enum ApnsEnvironment: String, Codable, Sendable {
    case sandbox, production

    /// Reads `PWUSAGE_APS_ENVIRONMENT`, which project.yml sets from the same build
    /// setting as the entitlement, so the two cannot disagree.
    static func fromBundle(_ bundle: Bundle = .main) -> Self? {
        switch bundle.object(forInfoDictionaryKey: "PWUSAGE_APS_ENVIRONMENT") as? String {
        case "development": .sandbox
        case "production": .production
        default: nil
        }
    }
}

struct BatteryHoldActivityRegistration: Encodable, Equatable, Sendable {
    let holdId: Int
    let registrationId: String
    let pushToken: String
    let apnsEnvironment: ApnsEnvironment
}

protocol BatteryHoldActivityAPI: Sendable {
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse
    func registerBatteryHoldActivity(siteID: String, registration: BatteryHoldActivityRegistration) async throws
    func unregisterBatteryHoldActivity(siteID: String, registrationID: UUID) async throws
}

/// `pending` is an activity iOS has accepted but not yet shown (iOS 26 scheduled
/// starts). The app never schedules one, so it is neither tracked as live nor
/// ended: a later reconcile adopts it once it is active.
enum BatteryHoldActivityLifecycle: Equatable, Sendable { case pending, active, stale, ended, dismissed }

/// One running Live Activity. ActivityKit in the app; a fake in tests.
@MainActor
protocol BatteryHoldActivityHandle: AnyObject {
    var id: String { get }
    var attributes: BatteryHoldActivityAttributes { get }
    var state: BatteryHoldActivityAttributes.ContentState { get }
    var lifecycle: BatteryHoldActivityLifecycle { get }
    var pushToken: Data? { get }
    func pushTokenUpdates() -> AsyncStream<Data>
    func lifecycleUpdates() -> AsyncStream<BatteryHoldActivityLifecycle>
    func update(_ state: BatteryHoldActivityAttributes.ContentState) async
    /// `immediately` removes it from the Lock Screen; otherwise the final state stays until the person or system removes it.
    func end(_ state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool) async
}

@MainActor
protocol BatteryHoldActivityHost: AnyObject {
    var activitiesEnabled: Bool { get }
    func activities() -> [any BatteryHoldActivityHandle]
    func start(attributes: BatteryHoldActivityAttributes,
               state: BatteryHoldActivityAttributes.ContentState) throws -> any BatteryHoldActivityHandle
}

/// Confirmed server state the dashboard reports, for the selected site.
enum BatteryHoldConfirmation {
    /// A database read of the site's hold status.
    case refreshed(BatteryHoldResponse)
    /// The person confirmed a start in this app and the server accepted it.
    case started(BatteryHold)
    /// The server accepted this app's stop and restored the original reserve.
    case stopped(holdID: Int)
}

@MainActor
protocol BatteryHoldActivityObserving: AnyObject {
    func batteryHoldConfirmed(_ confirmation: BatteryHoldConfirmation, siteID: String, timeZone: String?)
}

enum BatteryHoldLiveActivityOffer: Equatable {
    /// Live Activities are off for pwusage, or unsupported.
    case disabled
    /// No activity follows this hold here; the person may start one.
    case available
    case showing
}
