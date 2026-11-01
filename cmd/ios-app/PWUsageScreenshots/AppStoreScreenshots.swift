import XCTest

/// Captures the App Store listing screenshots. Run through
/// `bundle exec fastlane ios screenshots`, which supplies the devices, the
/// status bar override and the output folder; outside fastlane `snapshot(_:)`
/// does nothing, but the navigation and waits still run.
@MainActor
final class AppStoreScreenshots: XCTestCase {
    /// Matches `ScreenshotLaunch.argument` in the app; UI tests can't import it.
    private static let screenshotArgument = "-PWUsageScreenshotMode"
    private let timeout: TimeInterval = 20
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
        }
        app = XCUIApplication()
        app.launchArguments += [Self.screenshotArgument]
        setupSnapshot(app)
        app.launch()
        // The bill card replaces its loading placeholder only once demo data is in.
        XCTAssertTrue(element("home.bill").waitForExistence(timeout: timeout), "Home never finished loading")
    }

    func testIPhoneShots() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone set only")
        snapshot("01-home")
        scrollToToday()
        snapshot("02-home-today")
        captureTabs()
    }

    func testIPadShots() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad set only")
        snapshot("01-home")
        captureTabs()
    }

    private func captureTabs() {
        open("Bill")
        waitFor(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "146.82")).firstMatch)
        snapshot("03-bill")
        open("Smart Shift")
        waitFor(app.navigationBars["Smart Shift"])
        snapshot("04-smart-shift")
        open("Settings")
        waitFor(app.navigationBars["Settings"])
        snapshot("05-settings")
    }

    /// Scrolls Home until it stops moving, so Today so far, the bill and Smart
    /// Shift are all in view. On a 6.9" iPhone Home is too short to tuck the
    /// whole Live card under the bar, so the bar's live summary may not pin.
    private func scrollToToday() {
        let today = element("home.today")
        let scrollView = app.scrollViews.firstMatch
        for _ in 0 ..< 6 {
            let before = today.frame.minY
            let start = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let end = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            start.press(forDuration: 0.05, thenDragTo: end)
            if abs(today.frame.minY - before) < 1 { break }
        }
        XCTAssertTrue(today.isHittable, "Today so far isn't on screen")
        XCTAssertTrue(element("home.bill").isHittable, "Current bill isn't on screen")
    }

    /// A tab is a tab bar button on iPhone and a sidebar row on iPad.
    private func open(_ title: String) {
        let candidates = [app.tabBars.buttons[title], app.buttons[title], app.cells[title], app.staticTexts[title]]
        for candidate in candidates where candidate.exists && candidate.isHittable {
            candidate.tap()
            return
        }
        XCTFail("No tab named \(title)")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func waitFor(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Timed out waiting for \(element)")
    }
}
