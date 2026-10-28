import Combine
import OSLog
import SwiftUI
import UIKit
import WidgetKit

@main
struct PWUsageApp: App {
    /// Startup maintenance finishes before any model can read persisted credentials.
    private enum Launch {
        case starting
        case ready(PWUsageAppModel)
        case misconfigured(String)
    }

    @State private var launch: Launch = .starting
    private let launchTask: Task<Launch, Never>

    init() {
        launchTask = Task { @MainActor in await Self.prepareLaunch() }
    }

    private static func prepareLaunch() async -> Launch {
        do {
            try await AppLaunchMaintenance.run(
                defaults: .standard,
                buildVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                hasPersistedForecastState: {
                    try DeviceSolarForecastPersistence.hasPersistedState()
                },
                sweepCredentials: {
                    try await DeviceSolcastCredentialStore.shared.deleteAllCredentials()
                },
                clearSessionCookie: {
                    SharedWebSession.clearSessionCookies()
                },
                reloadControls: {
                    // Rebuild templates only after an update; retain saved site configuration.
                    ControlCenter.shared.reloadControls(ofKind: BatteryHoldControlIdentity.kind)
                }
            )
            let configuration = try AppConfiguration.fromBundle()
            let api = PWUsageAPI(configuration: configuration)
            return .ready(
                PWUsageAppModel(
                    configuration: configuration,
                    api: api,
                    cache: .persistent(apiOrigin: configuration.apiOrigin),
                    controlSiteStore: .shared(),
                    liveActivities: BatteryHoldActivityCoordinator(
                        host: ActivityKitBatteryHoldHost(),
                        api: api,
                        apnsEnvironment: .fromBundle(),
                        store: .init(defaults: .standard)
                    )
                )
            )
        } catch let error as AppConfiguration.ValidationError {
            // A Release build with an unusable origin has no server worth talking
            // to, so refuse rather than guess. Building a client here is exactly
            // the failure this replaces: it silently became a production client.
            PWUsageApp.reportMisconfiguration(error)
            return .misconfigured(
                "This build of pwusage was misconfigured and cannot choose a server. "
                    + "The bundled API origin was rejected as invalid."
            )
        } catch {
            PWUsageApp.reportMisconfiguration(error)
            return .misconfigured("pwusage could not finish secure startup. Close the app and try again.")
        }
    }

    private static func reportMisconfiguration(_ error: Error) {
        Logger(subsystem: "fm.rodeo.pwusage", category: "configuration")
            .error("Refusing to launch: \(String(describing: error), privacy: .public)")
    }

    var body: some Scene {
        WindowGroup {
            switch launch {
            case .starting:
                ProgressView("Starting pwusage…")
                    .task { launch = await launchTask.value }
            case .ready(let model):
                PWUsageRootView()
                    .environmentObject(model)
                    .environment(model.liveActivities)
            case .misconfigured(let message):
                EmptyStateScreen(
                    symbol: "exclamationmark.triangle",
                    title: "pwusage can’t start",
                    message: message,
                    actionTitle: "Copy details",
                    action: { Clipboard.copy(message) }
                )
            }
        }
        .commands {
            if case .ready(let model) = launch {
                PWUsageCommands(model: model)
            }
        }
    }
}
