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
        allow(.landscape, in: scene)
        return wasPortrait
    }

    /// How long a turn takes, which callers wait out so they can hide the redraw behind black.
    static let turnDuration: Duration = .milliseconds(450)

    /// Turns back to where `enterLandscape` found the phone, waits for the turn, then lets the phone follow the
    /// person's hand again. Returns once the screen is back.
    @MainActor
    static func restore(wasPortrait: Bool) async {
        guard rotates(on: UIDevice.current.userInterfaceIdiom), let scene = activeScene else { return }
        guard wasPortrait else {
            allow(.allButUpsideDown, in: scene, rotating: false)
            return
        }
        allow(restoringMask(wasPortrait: wasPortrait), in: scene)
        try? await Task.sleep(for: turnDuration)
        allow(.allButUpsideDown, in: scene, rotating: false)
    }

    /// Narrows what the app allows to `mask`, tells every view controller to look again, and asks for the turn.
    @MainActor
    private static func allow(_ mask: UIInterfaceOrientationMask, in scene: UIWindowScene, rotating: Bool = true) {
        OrientationDelegate.supported = mask
        var controller = scene.keyWindow?.rootViewController
        while let current = controller {
            current.setNeedsUpdateOfSupportedInterfaceOrientations()
            controller = current.presentedViewController
        }
        if rotating { request(mask, on: scene) }
    }

    @MainActor
    private static func request(_ mask: UIInterfaceOrientationMask, on scene: UIWindowScene) {
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
            // Expected while the new limit propagates: the turn still happens once the controllers have looked again.
            log.info("Orientation request \(mask.rawValue) not applied: \(error.localizedDescription)")
        }
    }

    /// The window scene on screen, preferring the active one.
    @MainActor private static var activeScene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }
}
