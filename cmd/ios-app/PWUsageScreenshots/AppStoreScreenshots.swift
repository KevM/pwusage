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
    }

    private func prepareHome() {
        app.launch()
        // Bill and live readings load separately; wait for each placeholder to go.
        XCTAssertTrue(element("home.bill").waitForExistence(timeout: timeout), "Home never finished loading")
        waitFor(label("Battery charge 64 percent"))
        waitFor(app.staticTexts["15.2 kWh"])
    }

    func testIPhoneShots() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone set only")
        try XCTSkipIf(isDuo, "iPhone standard set only")
        prepareHome()
        snapshot("01-home")
        scrollToToday()
        snapshot("02-home-today")
        captureTabs()
    }

    func testIPadShots() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad set only")
        prepareHome()
        snapshot("01-home")
        captureTabs()
    }

    /// The open Duo is regular width, so Home already shows Live, Today and
    /// the summary cards; it needs the iPad-style list, not 02-home-today.
    func testDuoShots() throws {
        try XCTSkipUnless(isDuo, "Duo set only")
        prepareHome()
        snapshot("01-home")
        captureTabs()
    }

    private func captureTabs() {
        open("Bill")
        // The demo's amount moves with the cycle day; the recorded total's label doesn't.
        waitFor(app.staticTexts["So far"])
        snapshot("03-bill")
        open("Smart Shift")
        // The bar is there from the first frame; the verdict card's link is not.
        waitFor(label("How this is worked out"))
        snapshot("04-smart-shift")
        open("Settings")
        waitFor(app.staticTexts["Hill Country Electric"])
        snapshot("05-settings")
        openSolarSystem()
        snapshot("06-solar-system")
    }

    /// The Settings row's label carries the found status, so reach it by
    /// identifier; wait for the details card rather than the screen's title.
    private func openSolarSystem() {
        let row = element("settings.solar-system")
        XCTAssertTrue(row.waitForExistence(timeout: timeout), "No Solar System row")
        row.tap()
        waitFor(app.staticTexts["Total size"])
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

    /// The Duo is an iPhone idiom, so the idiom alone cannot separate the sets.
    private var isDuo: Bool {
        (ProcessInfo().environment["SIMULATOR_DEVICE_NAME"] ?? "").contains("iPhone Duo")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func label(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
    }

    private func waitFor(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Timed out waiting for \(element)")
    }
}
