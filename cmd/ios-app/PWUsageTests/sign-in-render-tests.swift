import SwiftUI
import Testing
import UIKit
@testable import PWUsage

/// Renders the sign-in screen variants to PNGs for visual review, including
/// the compressed layout that is difficult to inspect in a static preview.
@MainActor
@Suite("Sign in rendering", .serialized)
struct SignInRenderTests {
    enum Variant: String, CaseIterable, Sendable {
        case light
        case dark
        case connecting
        case signingOut
        case error
        case accessibility
        case smallScreen

        var size: CGSize {
            switch self {
            case .smallScreen, .accessibility:
                CGSize(width: 320, height: 568)
            default:
                CGSize(width: 393, height: 852)
            }
        }

        var scheme: ColorScheme {
            self == .dark ? .dark : .light
        }

        var dynamicType: DynamicTypeSize {
            self == .accessibility ? .accessibility3 : .large
        }

        var isWorking: Bool {
            self == .connecting || self == .signingOut
        }

        var workingTitle: String {
            self == .signingOut ? "Signing out…" : "Connecting…"
        }

        var message: String? {
            switch self {
            case .error, .accessibility, .smallScreen:
                "Your session expired. Sign in to continue."
            default:
                nil
            }
        }
    }

    @Test("Renders sign-in screen variants for visual review", arguments: Variant.allCases)
    func render(_ variant: Variant) throws {
        let view = SignInView(
            isWorking: variant.isWorking,
            workingTitle: variant.workingTitle,
            message: variant.message,
            onSignIn: {}
        )
        .frame(width: variant.size.width, height: variant.size.height)
        .environment(\.colorScheme, variant.scheme)
        .environment(\.dynamicTypeSize, variant.dynamicType)

        let image = snapshot(view, size: variant.size, scheme: variant.scheme)
        #expect(image.size.width > 0)
        #expect(image.size.height > 0)

        let png = try #require(image.pngData())
        let output = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pwusage-sign-in-\(variant.rawValue).png")
        try png.write(to: output)
        print("Rendered sign in: \(output.path)")
    }

    private func snapshot(_ view: some View, size: CGSize, scheme: ColorScheme) -> UIImage {
        let host = UIHostingController(rootView: view)
        host.view.frame = CGRect(origin: .zero, size: size)
        host.view.backgroundColor = .clear

        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        window.rootViewController = host
        window.isHidden = false
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()

        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }
}
