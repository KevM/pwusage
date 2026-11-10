import SwiftUI
import WebKit

/// The web app's screens page for one device. It signs in with the app's own session cookie, so
/// there is no second sign-in, and it keeps nothing of its own: the store is not persistent.
struct TrmnlScreensWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(host: url.host()) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
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

    /// Keeps the sheet on the web app; any other site, such as a link out to trmnl.com, opens in Safari.
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let host: String?

        init(host: String?) { self.host = host }

        func webView(
            _: WKWebView, decidePolicyFor action: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let target = action.request.url, target.host() != host, target.scheme?.hasPrefix("http") == true
            else { return .allow }
            await UIApplication.shared.open(target)
            return .cancel
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
    }
}
