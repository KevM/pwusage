#if DEBUG
    import Foundation

    /// Launches the app in demo mode for the App Store screenshot run
    /// (`fastlane ios screenshots`), so the listing shows what reviewers see.
    /// The launch argument is DEBUG-only so a Release build can't reach it; the
    /// demo itself ships in Release.
    enum ScreenshotLaunch {
        static let argument = "-PWUsageScreenshotMode"
        static let site = DemoFixtures.site

        static func isRequested(in arguments: [String]) -> Bool {
            arguments.contains(argument)
        }

        @MainActor
        static func makeModel() -> PWUsageAppModel {
            DemoSession.makeModel()
        }
    }
#endif
