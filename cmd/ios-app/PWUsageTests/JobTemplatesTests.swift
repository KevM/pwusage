import Foundation
@testable import PWUsage
import Testing

@Suite("Job templates")
struct JobTemplatesTests {
    @Test("Lists the six templates in order")
    func listsTheSixTemplatesInOrder() {
        #expect(JobTemplates.all.map(\.id) ==
            ["ev", "dishwasher", "washer", "dryer", "washer-dryer-combo", "custom"])
        #expect(JobTemplates.all.map(\.title) ==
            ["Electric car", "Wash the dishes", "Wash the laundry", "Dry the laundry",
             "Wash and dry the laundry", "Custom job"])
    }

    @Test("Every template draft is valid and starts new")
    func everyTemplateDraftIsValid() {
        for template in JobTemplates.all {
            #expect(template.draft.isValid, "\(template.id)")
            #expect(template.draft.id == nil)
        }
    }

    @Test("Appliance templates leave the action word to the name")
    func applianceTemplatesLeaveTheVerbToTheName() throws {
        func draft(_ id: String) throws -> ProfileDraft {
            try #require(JobTemplates.all.first { $0.id == id }).draft
        }
        let dishwasher = try draft("dishwasher")
        #expect(dishwasher.kind == .appliance)
        #expect(dishwasher.actionVerb == nil)
        #expect(dishwasher.energyKwh == 5)
        #expect(dishwasher.durationHours == 2)
        #expect(try draft("washer").energyKwh == 2)
        #expect(try draft("dryer").actionVerb == nil)
        #expect(try draft("dryer").durationHours == 1)
        #expect(try draft("washer-dryer-combo").energyKwh == 8)
    }

    @Test("The electric car template uses the car defaults")
    func evTemplateIsTheNewCarDraft() throws {
        let electricCar = try #require(JobTemplates.all.first { $0.id == "ev" }).draft
        #expect(electricCar.kind == .car)
        #expect(electricCar.carSettings?.capacityKwh == 60)
        #expect(electricCar.actionVerb == nil)
    }

    @Test("The custom template starts Medium")
    func customTemplateStartsMedium() throws {
        let custom = try #require(JobTemplates.all.first { $0.id == "custom" }).draft
        #expect(custom.kind == .custom)
        #expect(custom.size == .medium)
        #expect(custom.energyKwh == 6)
        #expect(custom.durationHours == 2)
        #expect(custom.actionVerb == nil)
    }
}
