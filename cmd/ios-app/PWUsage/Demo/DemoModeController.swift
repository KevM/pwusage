import Combine
import SwiftUI

/// Holds the demo model while the demo runs. The app renders it in place of
/// the real model, which is never touched, so leaving finds the sign-in screen
/// exactly as it was. Lives only in memory: a relaunch always starts signed out.
@MainActor
final class DemoModeController: ObservableObject {
    @Published private(set) var model: PWUsageAppModel?
    private let suiteName: String

    init(suiteName: String = DemoSession.defaultsSuiteName) {
        self.suiteName = suiteName
    }

    func start() {
        guard model == nil else { return }
        model = DemoSession.makeModel(suiteName: suiteName)
    }

    func exit() {
        model = nil
        DemoSession.tearDown(suiteName: suiteName)
    }
}

/// What the sign-in screen, the demo bar and Settings can do about the demo.
struct DemoModeActions {
    let start: () -> Void
    let exit: () -> Void
    /// Leaves the demo, then starts the real Tesla sign-in.
    let exitAndSignIn: () -> Void

    @MainActor
    init(controller: DemoModeController, signIn: @escaping @MainActor () async -> Void) {
        start = { controller.start() }
        exit = { controller.exit() }
        exitAndSignIn = {
            controller.exit()
            Task { await signIn() }
        }
    }
}

extension EnvironmentValues {
    /// Nil where the demo isn't offered.
    @Entry var demoMode: DemoModeActions?
    /// True under the demo's model, for screens that show sample data read-only.
    @Entry var isDemo = false
}
