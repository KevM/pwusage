@testable import PWUsage
import Testing

struct SmartShiftSelectionTests {
    private let choices = [SmartShiftChoice(id: .recommended, label: "Later", price: "$1", caption: ""),
                           SmartShiftChoice(id: .now, label: "Now", price: "$2", caption: "")]

    @Test func returnKeepsMarksUntilLanding() {
        var selection = SmartShiftSelection(choices: choices)
        selection.select(.now)
        selection.beginReturn()
        #expect(selection.selected == .recommended)
        #expect(selection.marks == .now)
        #expect(selection.isReturning)
        selection.select(.now)
        #expect(selection.selected == .recommended)
        selection.landReturn()
        #expect(selection.marks == .recommended)
        #expect(!selection.isReturning)
    }

    @Test func refreshRemovingChoiceEndsReturn() {
        var selection = SmartShiftSelection(choices: choices)
        selection.select(.now)
        selection.beginReturn()
        selection.reconcile(with: [choices[1]])
        #expect(selection.selected == .now)
        #expect(selection.marks == .now)
        #expect(!selection.isReturning)
    }
}
