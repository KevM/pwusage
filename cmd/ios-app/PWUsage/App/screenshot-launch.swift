#if DEBUG
    import Foundation

    /// Launches the app signed in on demo data for the App Store screenshot run
    /// (`fastlane ios screenshots`). DEBUG-only so a Release build can't reach it.
    enum ScreenshotLaunch {
        static let argument = "-PWUsageScreenshotMode"

        /// A plausible home for the listing: the fixtures' "Demo utility" would
        /// show on screen.
        static let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Hill Country Electric")

        static func isRequested(in arguments: [String]) -> Bool {
            arguments.contains(argument)
        }

        /// Built on the preview model, which keeps its own defaults suite and a
        /// temporary cache, so a capture run leaves normal Debug state alone.
        @MainActor
        static func makeModel() -> PWUsageAppModel {
            .preview(api: MultiSitePreviewAPI(sites: [site]), tab: .home)
        }
    }
#endif
