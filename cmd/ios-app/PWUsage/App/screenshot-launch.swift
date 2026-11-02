#if DEBUG
    import Foundation

    /// Launches the app signed in on sample data for the App Store screenshot run
    /// (`fastlane ios screenshots`), so the listing shows what reviewers see without
    /// the demo mode bar or exit UI. The launch argument is DEBUG-only so a Release
    /// build can't reach it; the sample fixtures ship in Release for demo mode.
    enum ScreenshotLaunch {
        static let argument = "-PWUsageScreenshotMode"
        static let site = DemoFixtures.site

        static func isRequested(in arguments: [String]) -> Bool {
            arguments.contains(argument)
        }

        @MainActor
        static func makeModel() -> PWUsageAppModel {
            DemoSession.makeModel(suiteName: "pwusage.screenshots", isDemo: false)
        }
    }
#endif
