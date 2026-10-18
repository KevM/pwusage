import Testing
@testable import PWUsage

/// Turning an array on used to change only on-screen state; the selection
/// persisted only through a separate button below the list. People toggled,
/// left, and found the forecast still asking them to choose arrays -- then
/// rediscovered, spending a Solcast request each time.
@Suite("Solar forecast array selection")
struct SolarForecastArraySelectionTests {
    @Test("Turning an array on saves the new selection")
    func togglingOnSaves() {
        #expect(SolarForecastArraySelection.toggle("harrison", on: true, current: []) == .save(["harrison"]))
        #expect(SolarForecastArraySelection.toggle("b", on: true, current: ["a"]) == .save(["a", "b"]))
    }

    @Test("Turning one of two arrays off saves the remaining one")
    func togglingOffSavesRemainder() {
        #expect(SolarForecastArraySelection.toggle("a", on: false, current: ["a", "b"]) == .save(["b"]))
    }

    @Test("A third array and an empty selection are refused, not saved")
    func limitsAreRefused() {
        #expect(SolarForecastArraySelection.toggle("c", on: true, current: ["a", "b"]) == .refuse("Select at most two arrays."))
        guard case .refuse = SolarForecastArraySelection.toggle("a", on: false, current: ["a"]) else {
            Issue.record("Deselecting the only array must not save an empty selection")
            return
        }
    }

    @Test("Toggling to the state already saved does nothing")
    func unchangedSelectionIsIgnored() {
        #expect(SolarForecastArraySelection.toggle("a", on: true, current: ["a"]) == .unchanged)
        #expect(SolarForecastArraySelection.toggle("z", on: false, current: ["a"]) == .unchanged)
    }
}
