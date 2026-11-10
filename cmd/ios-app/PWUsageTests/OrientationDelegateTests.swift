@testable import PWUsage
import Testing
import UIKit

@MainActor
@Suite("Orientation delegate")
struct OrientationDelegateTests {
    @Test("The app allows every way up but upside down until a full-screen view narrows it")
    func defaultsToAllButUpsideDown() {
        #expect(OrientationDelegate.supported == .allButUpsideDown)
    }

    @Test("The delegate answers with whatever is currently allowed")
    func answersWithTheCurrentMask() {
        let delegate = OrientationDelegate()
        defer { OrientationDelegate.supported = .allButUpsideDown }
        OrientationDelegate.supported = .landscape
        #expect(delegate.application(UIApplication.shared, supportedInterfaceOrientationsFor: nil) == .landscape)
    }
}
