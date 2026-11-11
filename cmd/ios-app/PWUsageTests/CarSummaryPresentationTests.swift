@testable import PWUsage
import Testing

@Suite("Car summary presentation")
struct CarSummaryPresentationTests {
    private func car(name: String = "Model Y", current: Double, target: Double) -> LoadProfile {
        LoadProfile(
            id: "model-y", name: name, kind: .car, energyKwh: 30, durationHours: 3,
            carSettings: CarLoadSettings(capacityKwh: 75, initialStateOfCharge: current,
                                         targetStateOfCharge: target, chargingLevel: .level2))
    }

    @Test("Summarises a car as name, current charge and target")
    func formatsNameAndCharge() {
        #expect(LoadTimingPresentation.carSummary(car(current: 30, target: 80)) == "Model Y · 30% → 80%")
    }

    @Test("Other jobs have no car summary")
    func isNilForNonCarJobs() {
        let washer = LoadProfile(id: "washer", name: "Wash the laundry", kind: .appliance, energyKwh: 2,
                                 durationHours: 1.5, carSettings: nil)
        #expect(LoadTimingPresentation.carSummary(washer) == nil)
        #expect(LoadTimingPresentation.carSummaryAccessibilityLabel(washer) == nil)
    }

    @Test("Shows an off-grid saved charge exactly as saved")
    func showsOffGridValuesAsSaved() {
        #expect(LoadTimingPresentation.carSummary(car(current: 37, target: 80)) == "Model Y · 37% → 80%")
    }

    @Test("Reads the charge aloud in words")
    func accessibilityLabelUsesWords() {
        #expect(LoadTimingPresentation.carSummaryAccessibilityLabel(car(current: 30, target: 80))
            == "Model Y, charge now 30 percent, charging to 80 percent")
    }
}
