import os
import UIKit

/// Turns a phone to landscape for a full-screen view and back again, as a video player does. An iPad or a
/// Mac window keeps its shape: the full-screen view just fills it.
enum ScreenOrientation {
    private static let log = Logger(subsystem: "fm.rodeo.pwusage", category: "orientation")

    /// What to ask for on leaving: portrait if the phone was upright when it left, else any way up.
    static func restoringMask(wasPortrait: Bool) -> UIInterfaceOrientationMask {
        wasPortrait ? .portrait : .allButUpsideDown
    }

    static func rotates(on idiom: UIUserInterfaceIdiom) -> Bool {
        idiom == .phone
    }

    /// Asks the phone to turn to landscape. Returns whether it was upright, to hand back to `restore`.
    @MainActor
    static func enterLandscape() -> Bool {
        guard rotates(on: UIDevice.current.userInterfaceIdiom), let scene = activeScene else { return false }
        let wasPortrait = scene.interfaceOrientation.isPortrait
        request(.landscape, on: scene)
        return wasPortrait
    }

    /// Turns back to where `enterLandscape` found the phone, then lets it follow the person's hand again.
    @MainActor
    static func restore(wasPortrait: Bool) async {
        guard rotates(on: UIDevice.current.userInterfaceIdiom), let scene = activeScene else { return }
        request(restoringMask(wasPortrait: wasPortrait), on: scene)
        // Leave the request in place while the turn happens, then stop constraining the phone.
        try? await Task.sleep(for: .milliseconds(600))
        request(.allButUpsideDown, on: scene)
    }

    @MainActor
    private static func request(_ mask: UIInterfaceOrientationMask, on scene: UIWindowScene) {
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
            log.error("Orientation request \(mask.rawValue) failed: \(error.localizedDescription)")
        }
    }

    /// The window scene on screen, preferring the active one.
    @MainActor private static var activeScene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }
}
