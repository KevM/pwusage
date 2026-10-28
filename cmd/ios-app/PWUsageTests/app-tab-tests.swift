@testable import PWUsage
import Testing

@Suite("App Tab Tests")
struct AppTabTests {
    @Test("Tabs keep their order, titles and symbols")
    func tabsMatchDesign() {
        #expect(AppTab.allCases == [.home, .bill, .smartShift, .settings])
        #expect(AppTab.allCases.map(\.title) == ["Home", "Bill", "Smart Shift", "Settings"])
        #expect(AppTab.allCases.map(\.systemImage) == ["house", "receipt", "bolt.badge.clock", "gearshape"])
        #expect(AppTab(rawValue: "smartShift") == .smartShift)
    }
}
