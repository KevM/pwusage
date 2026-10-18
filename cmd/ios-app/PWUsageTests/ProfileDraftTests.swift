import Testing
@testable import PWUsage

/// Swiping the job editor away used to discard edits silently. The editor now
/// asks first, but only when something actually changed, so an untouched
/// sheet still closes with a single swipe or Cancel.
@Suite("Job editor unsaved changes")
struct ProfileDraftTests {
    private let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3.5, durationHours: 2, carSettings: nil)
    private let car = LoadProfile(
        id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
        carSettings: CarLoadSettings(capacityKwh: 80, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level2)
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
}
