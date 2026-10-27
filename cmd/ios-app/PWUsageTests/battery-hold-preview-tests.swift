@testable import PWUsage
import SwiftUI
import Testing

@MainActor
@Suite("Battery hold previews", .serialized)
struct BatteryHoldPreviewTests {
    @Test("Preview fixtures cover idle, ambiguous, active and cancelled holds", arguments: [
        BatteryHoldPreviewAPI.Mode.idle, .ambiguous, .active, .monitoring, .notice,
    ])
    func fixtures(_ mode: BatteryHoldPreviewAPI.Mode) async throws {
        let api = BatteryHoldPreviewAPI(mode: mode)
        let live = try await api.fetchLive(siteID: "preview-home")
        let response = try await api.fetchBatteryHold(siteID: "preview-home").validating(siteID: "preview-home")
        #expect(live.stateOfCharge == (mode == .ambiguous ? 90 : 72))
        #expect((response.hold != nil) == (mode == .active || mode == .monitoring))
        #expect((response.notice != nil) == (mode == .notice))
    }

    @Test("Render compact toolbar glyph in idle and active states")
    func renderToolbar() async throws {
        for mode in [BatteryHoldPreviewAPI.Mode.idle, .monitoring] {
            let response = try await BatteryHoldPreviewAPI(mode: mode).fetchBatteryHold(siteID: "preview-home")
            let now = Date.now
            let state = BatteryHoldState(response: response, isCurrent: true, fetchedAt: now)
            let renderer = ImageRenderer(content: BatteryHoldToolbarLabel(state: state, now: now)
                .padding(16).background(Color.white))
            renderer.scale = 3
            let png = try #require(renderer.uiImage?.pngData())
            let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("battery-hold-toolbar-\(mode).png")
            try png.write(to: output)
            print("Battery hold toolbar render: \(output.path)")
        }
    }

    @Test("Render native sheet states at standard and accessibility text sizes")
    func renderSheets() async throws {
        // A native Form includes UIKit-backed controls that ImageRenderer cannot
        // capture. Host the real sheet in a test-only window for visual inspection.
        // The test runner can start before the app has connected its first scene.
        for _ in 0..<50 where UIApplication.shared.connectedScenes.isEmpty {
            try await Task.sleep(for: .milliseconds(100))
        }
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let priorWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let container = RenderContainer()
        window.rootViewController = container
        window.makeKeyAndVisible()
        defer { window.isHidden = true; priorWindow?.makeKey() }
        for mode in [BatteryHoldPreviewAPI.Mode.idle, .ambiguous, .active, .monitoring, .notice] {
            let coordinator = DashboardCoordinator(siteID: "preview-home", api: BatteryHoldPreviewAPI(mode: mode), timerInterval: nil)
            await coordinator.refreshAll(trigger: .userGesture)
            await coordinator.refreshBatteryHold()
            #expect(coordinator.batteryHold.isCurrent)
            for largeText in [false, true] {
                let view = BatteryHoldSheet(coordinator: coordinator, site: .init(id: "preview-home", name: "Cedar House", utility: "Demo utility"))
                    .environment(\.dynamicTypeSize, largeText ? .accessibility3 : .large)
                    .environment(\.colorScheme, .light)
                let host = UIHostingController(rootView: view)
                container.addChild(host)
                host.beginAppearanceTransition(true, animated: false)
                host.view.frame = container.view.bounds
                container.view.addSubview(host.view)
                host.didMove(toParent: container)
                host.endAppearanceTransition()
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let png = try #require(image.pngData())
                let output = URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("battery-hold-\(mode)-\(largeText ? "accessibility" : "standard").png")
                try png.write(to: output)
                print("Battery hold render: \(output.path)")
                host.willMove(toParent: nil)
                host.beginAppearanceTransition(false, animated: false)
                host.view.removeFromSuperview()
                host.endAppearanceTransition()
                host.removeFromParent()
            }
        }
    }

    private final class RenderContainer: UIViewController {
        // Rendered children have explicit, synchronous appearance transitions.
        override var shouldAutomaticallyForwardAppearanceMethods: Bool { false }
    }
}
