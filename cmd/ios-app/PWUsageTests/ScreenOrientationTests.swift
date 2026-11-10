@testable import PWUsage
import Testing
import UIKit

@Suite("Screen orientation")
struct ScreenOrientationTests {
    @Test("Closing full screen goes back to portrait only when it started there")
    func restoresWhereItStarted() {
        #expect(ScreenOrientation.restoringMask(wasPortrait: true) == .portrait)
        #expect(ScreenOrientation.restoringMask(wasPortrait: false) == .allButUpsideDown)
    }

    @Test("Only a phone is asked to turn; an iPad or a Mac window keeps its shape")
    func onlyPhonesRotate() {
        #expect(ScreenOrientation.rotates(on: .phone))
        #expect(!ScreenOrientation.rotates(on: .pad))
        #expect(!ScreenOrientation.rotates(on: .mac))
    }
}
