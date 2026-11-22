@testable import PWUsageCore
import Testing

@Suite("PWUsageCore smoke")
struct PWUsageCoreSmokeTests {
    @Test("Package module is importable on macOS")
    func moduleImports() {
        #expect(String(describing: PWUsageCoreModule.self) == "PWUsageCoreModule")
    }
}
