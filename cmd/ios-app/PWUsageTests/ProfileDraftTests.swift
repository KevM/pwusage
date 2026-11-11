@testable import PWUsage
import Testing

/// Swiping the job editor away used to discard edits silently. The editor now
/// asks first, but only when something actually changed, so an untouched
/// sheet still closes with a single swipe or Cancel.
@Suite("Job editor unsaved changes")
struct ProfileDraftTests {
    private let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5,
                                     durationHours: 2, carSettings: nil)
    private let car = LoadProfile(
        id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
        carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 20,
                                     targetStateOfCharge: 80, chargingLevel: .level2)
    )

    @Test("An untouched draft has no unsaved changes")
    func untouchedDraftIsClean() {
        let original = ProfileDraft(profile: washer)
        #expect(!original.hasUnsavedChanges(from: original))
        #expect(!ProfileDraft.newCustom().hasUnsavedChanges(from: .newCustom()))
    }

    @Test("Changing energy, duration, or name is an unsaved change")
    func fieldEditsAreUnsaved() {
        let original = ProfileDraft(profile: washer)
        var energy = original
        energy.energyKwh = 4
        #expect(energy.hasUnsavedChanges(from: original))
        var duration = original
        duration.durationHours = 3
        #expect(duration.hasUnsavedChanges(from: original))
        var named = ProfileDraft.newCustom()
        named.name = "Dryer"
        #expect(named.hasUnsavedChanges(from: .newCustom()))
    }

    @Test("Changing car charge settings is an unsaved change")
    func carEditsAreUnsaved() {
        let original = ProfileDraft(profile: car)
        var edited = original
        edited.carSettings?.targetStateOfCharge = 90
        #expect(edited.hasUnsavedChanges(from: original))
    }

    @Test("Editing a value and putting it back is not an unsaved change")
    func revertedEditIsClean() {
        let original = ProfileDraft(profile: washer)
        var edited = original
        edited.energyKwh = 4
        edited.energyKwh = 3.5
        #expect(!edited.hasUnsavedChanges(from: original))
    }

    @Test("A new car draft is valid and starts from the car defaults")
    func newCarDraftIsValidAndUsesCarDefaults() {
        let draft = ProfileDraft.newCar()
        #expect(draft.id == nil)
        #expect(draft.kind == .car)
        #expect(draft.carSettings?.capacityKwh == 60)
        #expect(draft.carSettings?.initialStateOfCharge == 20)
        #expect(draft.carSettings?.targetStateOfCharge == 80)
        #expect(draft.isValid)
        #expect(draft.sheetID != ProfileDraft.newCustom().sheetID)
    }

    @Test("A blank name is invalid for every kind of job")
    func blankNameIsInvalidForEveryKind() {
        for original in [ProfileDraft(profile: washer), .newCar(), .newCustom()] {
            var draft = original
            #expect(draft.isValid)
            draft.name = "   "
            #expect(!draft.isValid)
        }
    }

    @Test("Renaming a car is an unsaved change")
    func changingCarNameIsAnUnsavedChange() {
        let original = ProfileDraft(profile: car)
        var renamed = original
        renamed.name = "Leaf"
        #expect(renamed.hasUnsavedChanges(from: original))
    }

    @Test("Picking a size resets energy and hours to that size's defaults")
    func applyingASizeResetsEnergyAndHours() {
        let large = ProfileDraft.newCustom().applying(size: .large)
        #expect(large.size == .large)
        #expect(large.energyKwh == 20)
        #expect(large.durationHours == 4)
        let medium = large.applying(size: .medium)
        #expect(medium.energyKwh == 6)
        #expect(medium.durationHours == 2)
    }

    @Test("Stepping energy or hours never changes the size")
    func steppingEnergyNeverChangesSize() {
        var draft = ProfileDraft.newCustom()
        draft.energyKwh = 9
        draft.durationHours = 3.5
        #expect(draft.size == .medium)
    }

    @Test("The energy step follows the size")
    func stepFollowsSize() {
        let draft = ProfileDraft.newCustom()
        #expect(draft.applying(size: .small).energyStepKwh == 0.5)
        #expect(draft.applying(size: .medium).energyStepKwh == 1)
        #expect(draft.applying(size: .large).energyStepKwh == 5)
        #expect(ProfileDraft(profile: washer).energyStepKwh == 0.5)
    }

    @Test("Changing the size is an unsaved change")
    func changingSizeIsAnUnsavedChange() {
        let original = ProfileDraft.newCustom()
        #expect(original.applying(size: .large).hasUnsavedChanges(from: original))
    }

    @Test("Editing a saved job keeps its size and verb in the draft")
    func draftCarriesSizeAndVerb() {
        let tub = LoadProfile(id: "tub", name: "Hot tub", kind: .custom, energyKwh: 20, durationHours: 4,
                              carSettings: nil, size: .large, actionVerb: "Heat")
        let draft = ProfileDraft(profile: tub)
        #expect(draft.size == .large)
        #expect(draft.actionVerb == "Heat")
    }
}
