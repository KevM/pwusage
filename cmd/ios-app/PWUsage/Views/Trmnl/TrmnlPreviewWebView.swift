import SwiftUI
import WebKit

/// Shows the site's Trmnl screen as the device would draw it. The document is self-contained, so
/// scripts are off and the view takes no touches; its width=800 viewport scales it to the view.
struct TrmnlPreviewWebView: UIViewRepresentable {
    /// The 800 by 480 pixel screen of a Trmnl.
    static let aspectRatio: CGFloat = 800 / 480

    let document: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context _: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isUserInteractionEnabled = false
        view.scrollView.isScrollEnabled = false
        view.isOpaque = true
        view.backgroundColor = .white
        view.scrollView.backgroundColor = .white
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedDocument != document else { return }
        context.coordinator.loadedDocument = document
        view.loadHTMLString(document, baseURL: nil)
    }

    final class Coordinator {
        var loadedDocument: String?
    }
}
