import SwiftUI
import WebKit

/// Draws the site's Trmnl screen as the device would, at its own 800 by 480 points: give it that frame
/// and scale it (see `TrmnlPreview`). The document is self-contained, so scripts are off and the
/// view takes no touches.
struct TrmnlPreviewWebView: UIViewRepresentable {
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
