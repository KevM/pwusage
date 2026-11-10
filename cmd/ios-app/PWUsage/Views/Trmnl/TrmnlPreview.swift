import SwiftUI

/// The site's Trmnl screen at the width it is given. The web view is laid out at the device's own
/// 800 by 480 and scaled here, rather than leaving the scaling to the page's viewport tag, which
/// WebKit does not apply reliably to a view that has no size when the page loads.
struct TrmnlPreview: View {
    nonisolated static let screenSize = CGSize(width: 800, height: 480)
    nonisolated static let aspectRatio = screenSize.width / screenSize.height

    let document: String

    var body: some View {
        GeometryReader { proxy in
            TrmnlPreviewWebView(document: document)
                .frame(width: Self.screenSize.width, height: Self.screenSize.height)
                .scaleEffect(proxy.size.width / Self.screenSize.width, anchor: .topLeading)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .aspectRatio(Self.screenSize.width / Self.screenSize.height, contentMode: .fit)
    }
}
