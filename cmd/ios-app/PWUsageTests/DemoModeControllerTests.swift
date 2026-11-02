import Foundation
@testable import PWUsage
import Testing

/// The controller holds the demo beside the real model and never touches the
/// real one, so leaving the demo finds the sign-in screen exactly as it was.
@MainActor
@Suite("Demo mode controller")
struct DemoModeControllerTests {
    /// Suites run in parallel, so each test owns its suite and folder.
    private let suiteName = "pwusage.demo.tests.\(UUID().uuidString)"

    @Test("Starting builds one demo model")
    func startBuildsDemoModel() throws {
        let controller = DemoModeController(suiteName: suiteName)
        defer { controller.exit() }
        #expect(controller.model == nil)
        controller.start()
        let model = try #require(controller.model)
        #expect(model.isDemo)
        controller.start()
        #expect(controller.model === model)
    }

    @Test("Exiting leaves no demo state behind")
    func exitLeavesNoDemoState() throws {
        let controller = DemoModeController(suiteName: suiteName)
        controller.start()
        controller.model?.selectTab(.bill)
        controller.exit()
        #expect(controller.model == nil)
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        #expect(defaults.dictionaryRepresentation()[PWUsageAppModel.selectedTabDefaultsKey] == nil)
        #expect(!FileManager.default.fileExists(atPath: DemoSession.folder(suiteName: suiteName).path))
    }

    @Test("Exiting restores the real sign-in screen, message and all")
    func exitRestoresRealSignInState() throws {
        let realSuite = "\(suiteName).real"
        defer { UserDefaults.standard.removePersistentDomain(forName: realSuite) }
        let real = PWUsageAppModel(
            configuration: try AppConfiguration(apiOrigin: AppConfiguration.defaultAPIOrigin),
            api: DemoAPI(), userDefaults: try #require(UserDefaults(suiteName: realSuite))
        )
        real.screenState = .signedOut
        real.signInMessage = "Your session expired. Sign in to continue."
        let controller = DemoModeController(suiteName: suiteName)
        controller.start()
        #expect(controller.model !== real)
        controller.exit()
        #expect(real.screenState == .signedOut)
        #expect(real.signInMessage == "Your session expired. Sign in to continue.")
        #expect(real.coordinator == nil)
    }

    @Test("The actions start and leave the demo")
    func actionsDriveController() async {
        let controller = DemoModeController(suiteName: suiteName)
        var signIns = 0
        let actions = DemoModeActions(controller: controller) { signIns += 1 }
        actions.start()
        #expect(controller.model != nil)
        actions.exit()
        #expect(controller.model == nil)
        #expect(signIns == 0)
        actions.start()
        actions.exitAndSignIn()
        #expect(controller.model == nil)
        await Task.yield()
        #expect(signIns == 1)
    }
}
