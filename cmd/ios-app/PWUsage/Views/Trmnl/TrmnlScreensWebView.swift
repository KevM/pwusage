import SwiftUI
import WebKit

/// The web app's screens page for one device. It signs in with the app's own session cookie, so
/// there is no second sign-in, and it keeps nothing of its own: the store is not persistent.
struct TrmnlScreensWebView: UIViewRepresentable {
    /// Marks the document before it paints, so the web app hides its site header and footer, which
    /// the sheet's own bar makes redundant. Sent to every page the view loads.
    nonisolated static let embeddedMarkerScript = "document.documentElement.setAttribute('data-embedded', '')"

    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(host: url.host()) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.embeddedMarkerScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        let cookies = (SharedWebSession.cookieStorage().cookies(for: url) ?? []).filter { $0.name == "site_auth" }
        let store = configuration.websiteDataStore.httpCookieStore
        let request = URLRequest(url: url)
        Task { @MainActor in
            for cookie in cookies { await store.setCookie(cookie) }
            view.load(request)
        }
        return view
    }

    func updateUIView(_: WKWebView, context _: Context) {}

    /// Keeps the sheet on the web app; any other site, such as a link out to trmnl.com, opens in Safari. It
    /// also shows the page's alert and confirm dialogs natively: a web view with no UI delegate answers
    /// every `confirm` with "cancel", so the page's Delete screen would do nothing.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let host: String?

        init(host: String?) { self.host = host }

        func webView(
            _: WKWebView, decidePolicyFor action: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            // A nil target frame is a link that opens a new window, which counts as leaving the page.
            let targetsMainFrame = action.targetFrame?.isMainFrame ?? true
            guard let target = action.request.url,
                  Self.opensExternally(target, host: host, targetsMainFrame: targetsMainFrame)
            else { return .allow }
            await UIApplication.shared.open(target)
            return .cancel
        }

        /// Only a link the person follows to another site leaves for Safari. A frame inside the page, such as
        /// the preview deployment's feedback toolbar, loads where it is.
        nonisolated static func opensExternally(_ target: URL, host: String?, targetsMainFrame: Bool) -> Bool {
            targetsMainFrame && target.host() != host && target.scheme?.hasPrefix("http") == true
        }

        func webView(
            _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame _: WKFrameInfo
        ) async {
            _ = await present(message: message, in: webView, canCancel: false)
        }

        func webView(
            _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame _: WKFrameInfo
        ) async -> Bool {
            await present(message: message, in: webView, canCancel: true)
        }

        /// Answers true on OK, false on Cancel or when there is nothing to present from.
        private func present(message: String, in webView: WKWebView, canCancel: Bool) async -> Bool {
            guard var presenter = webView.window?.rootViewController else { return false }
            while let presented = presenter.presentedViewController { presenter = presented }
            return await withCheckedContinuation { continuation in
                let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                    continuation.resume(returning: true)
                })
                if canCancel {
                    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                        continuation.resume(returning: false)
                    })
                }
                presenter.present(alert, animated: true)
            }
        }
    }
}

struct TrmnlScreensSheet: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TrmnlScreensWebView(url: url)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(TrmnlPresentation.screensTitle)
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        // The default form sheet keeps one fixed size, which on a Mac or iPad does not follow the window.
        .presentationSizing(.page)
    }
}
