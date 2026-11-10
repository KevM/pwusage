@testable import PWUsage
import Testing

@Suite("Trmnl screens web view")
struct TrmnlScreensWebViewTests {
    @Test("The page is marked embedded with the attribute the web app's stylesheet hides its chrome under")
    func marksDocumentEmbedded() {
        #expect(TrmnlScreensWebView.embeddedMarkerScript.contains("data-embedded"))
        #expect(TrmnlScreensWebView.embeddedMarkerScript.contains("documentElement"))
    }
}
