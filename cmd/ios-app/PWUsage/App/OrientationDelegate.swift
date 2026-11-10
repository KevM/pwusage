import UIKit

/// Owns which orientations the app allows right now. It allows every way up but upside down, except while a
/// full-screen view narrows it (see `ScreenOrientation`): iOS only turns the screen to an orientation this
/// mask and the view controller both allow, which is how a video player forces landscape.
final class OrientationDelegate: NSObject, UIApplicationDelegate {
    @MainActor static var supported: UIInterfaceOrientationMask = .allButUpsideDown

    @MainActor
    func application(
        _: UIApplication, supportedInterfaceOrientationsFor _: UIWindow?
    ) -> UIInterfaceOrientationMask {
        Self.supported
    }
}
