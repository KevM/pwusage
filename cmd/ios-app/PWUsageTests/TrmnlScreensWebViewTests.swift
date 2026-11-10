@testable import PWUsage
import Testing
import WebKit

@Suite("Trmnl screens web view")
struct TrmnlScreensWebViewTests {
    @Test("The page is marked embedded with the attribute the web app's stylesheet hides its chrome under")
    func marksDocumentEmbedded() {
        #expect(TrmnlScreensWebView.embeddedMarkerScript.contains("data-embedded"))
        #expect(TrmnlScreensWebView.embeddedMarkerScript.contains("documentElement"))
    }

    @Test("The sheet answers the page's alert and confirm dialogs, which a web view otherwise cancels")
    @MainActor
    func handlesJavaScriptDialogs() {
        #expect(TrmnlScreensWebView.Coordinator(host: nil) as Any is WKUIDelegate)
    }

    @Test("Only a followed link to another site leaves for Safari; frames inside the page load in place")
    func externalLinksOnly() throws {
        let host = "pwusage.example"
        let other = try #require(URL(string: "https://trmnl.com/plugin_settings/7/edit"))
        let toolbar = try #require(URL(string: "https://vercel.live/_next-live/feedback/feedback.html"))
        let own = try #require(URL(string: "https://pwusage.example/trmnl/manage"))
        let mail = try #require(URL(string: "mailto:help@example.com"))
        typealias Coordinator = TrmnlScreensWebView.Coordinator
        #expect(Coordinator.opensExternally(other, host: host, targetsMainFrame: true))
        #expect(!Coordinator.opensExternally(toolbar, host: host, targetsMainFrame: false))
        #expect(!Coordinator.opensExternally(own, host: host, targetsMainFrame: true))
        #expect(!Coordinator.opensExternally(mail, host: host, targetsMainFrame: true))
    }
}
