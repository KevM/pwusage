@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    @Test("A car's action word comes from its kind, not its name")
    func renamedCarStillSaysCharge() throws {
        let harrison = Self.harrisonSunday()
        for name in ["Model Y", "Car", "Leaf"] {
            var car = harrison.car
            car.name = name
            let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
                comparison: harrison.comparison, profile: car, timing: harrison.timing, now: harrison.now,
                billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC"))
            #expect(Self.normalized(try #require(breakdowns.first).title) == "Charge tomorrow at 4:30 PM")
            #expect(try #require(breakdowns.last).title == "Charge now")
        }
    }

    @Test("A renamed appliance does not use its name as an action word")
    func renamedApplianceStartsRatherThanQuotingItsName() throws {
        let harrison = Self.harrisonSunday()
        var dishes = harrison.car
        dishes = LoadProfile(id: "dishwasher", name: "Dishwasher (garage)", kind: .appliance,
                             energyKwh: dishes.energyKwh, durationHours: dishes.durationHours, carSettings: nil)
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: harrison.comparison, profile: dishes, timing: harrison.timing, now: harrison.now,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC"))
        #expect(try #require(breakdowns.last).title == "Start now")
    }
}
