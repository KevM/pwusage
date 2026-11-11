import Foundation
@testable import PWUsage
import Testing

extension LoadProfileStoreTests {
    @Test("Sizes carry the specified defaults and steps")
    func sizesHaveTheSpecifiedDefaults() {
        #expect(JobSize.allCases == [.small, .medium, .large])
        #expect(JobSize.small.title == "Small")
        #expect([JobSize.small, .medium, .large].map(\.defaultEnergyKwh) == [1.5, 6, 20])
        #expect([JobSize.small, .medium, .large].map(\.energyStepKwh) == [0.5, 1, 5])
        #expect([JobSize.small, .medium, .large].map(\.defaultDurationHours) == [1, 2, 4])
    }

    @Test("Adding a job stores its size and verb")
    @MainActor
    func addProfileStoresSizeAndVerb() throws {
        let fixture = ProfileStoreFixture()
        let added = try fixture.store.addProfile(NewProfile(
            name: " Hot tub ", kind: .custom, energyKwh: 20, durationHours: 4, size: .large, actionVerb: "Heat"))
        #expect(added.name == "Hot tub")
        #expect(added.size == .large)
        #expect(added.actionVerb == "Heat")
        #expect(UUID(uuidString: added.id) != nil)
        let restored = LoadProfileStore(userDefaults: fixture.defaults).profile(id: added.id)
        #expect(restored?.size == .large)
        #expect(restored?.actionVerb == "Heat")
    }

    @Test("A size on a non-custom job is rejected")
    @MainActor
    func addProfileRejectsSizeOnNonCustomJobs() {
        let store = ProfileStoreFixture().store
        #expect(throws: LoadProfileError.invalidProfile) {
            try store.addProfile(NewProfile(name: "Dishes", kind: .appliance, energyKwh: 5, durationHours: 2,
                                            size: .small))
        }
    }

    @Test("A blank verb is stored as nothing")
    @MainActor
    func blankVerbIsStoredAsNil() throws {
        let store = ProfileStoreFixture().store
        let added = try store.addProfile(NewProfile(name: "Oven", kind: .custom, energyKwh: 3, durationHours: 1,
                                                    actionVerb: "  "))
        #expect(added.actionVerb == nil)
    }

    @Test("A Phase 1 payload with no size or verb loads unchanged")
    @MainActor
    func phaseOnePayloadLoadsWithNoSizeOrVerb() throws {
        let fixture = ProfileStoreFixture()
        let expected = fixture.store.profiles
        let data = try #require(fixture.defaults.data(forKey: LoadProfileStore.storageKey))
        var payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var profiles = try #require(payload["profiles"] as? [[String: Any]])
        for index in profiles.indices {
            profiles[index].removeValue(forKey: "size")
            profiles[index].removeValue(forKey: "actionVerb")
        }
        payload["profiles"] = profiles
        fixture.defaults.set(try JSONSerialization.data(withJSONObject: payload), forKey: LoadProfileStore.storageKey)

        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profiles == expected)
        #expect(restored.profiles.allSatisfy { $0.size == nil && $0.actionVerb == nil })
    }

    @Test("A custom job without a size stays valid")
    @MainActor
    func customJobWithoutSizeStaysValid() throws {
        let store = ProfileStoreFixture().store
        #expect(store.profile(id: "custom-example")?.size == nil)
        _ = try store.editProfile(id: "custom-example", name: "Bake bread", energyKwh: 21, durationHours: 4)
        #expect(store.profile(id: "custom-example")?.energyKwh == 21)
    }

    @Test("Editing keeps or sets the size and verb")
    @MainActor
    func editProfileUpdatesSizeAndVerb() throws {
        let store = ProfileStoreFixture().store
        let added = try store.addProfile(NewProfile(name: "Oven", kind: .custom, energyKwh: 6, durationHours: 2,
                                                    size: .medium))
        let resized = try store.editProfile(id: added.id, edit: ProfileEdit(
            energyKwh: 20, durationHours: 4, size: .large, actionVerb: "Bake"))
        #expect(resized.size == .large)
        #expect(resized.actionVerb == "Bake")
        let untouched = try store.editProfile(id: added.id, energyKwh: 22, durationHours: 4)
        #expect(untouched.size == .large)
        #expect(untouched.actionVerb == "Bake")
    }

    @Test("Duplicating keeps the size and verb")
    @MainActor
    func duplicateKeepsSizeAndVerb() throws {
        let store = ProfileStoreFixture().store
        let added = try store.addProfile(NewProfile(name: "Oven", kind: .custom, energyKwh: 6, durationHours: 2,
                                                    size: .medium, actionVerb: "Bake"))
        let copy = try store.duplicateProfile(id: added.id)
        #expect(copy.size == .medium)
        #expect(copy.actionVerb == "Bake")
    }
}

extension LoadProfileStoreTests {
    @Test("Adding the same template twice makes two independent jobs")
    @MainActor
    func addingTheSameTemplateTwiceMakesTwoJobs() throws {
        let store = ProfileStoreFixture().store
        let template = try #require(JobTemplates.all.first { $0.id == "dishwasher" })
        let first = try store.addProfile(template.draft.newProfile)
        let second = try store.addProfile(template.draft.newProfile)
        #expect(first.id != second.id)
        #expect(store.profiles.filter { $0.name == "Wash the dishes" }.count == 3)
        #expect(first.actionVerb == nil)
    }

    @Test("A template can be added when no jobs are left")
    @MainActor
    func addsFromEmptyStore() throws {
        let fixture = ProfileStoreFixture()
        for profile in fixture.store.profiles { try fixture.store.deleteProfile(id: profile.id) }
        let template = try #require(JobTemplates.all.first { $0.id == "ev" })
        let added = try fixture.store.addProfile(template.draft.newProfile)
        #expect(fixture.store.profiles.map(\.id) == [added.id])
        #expect(LoadProfileStore(userDefaults: fixture.defaults).profiles.map(\.id) == [added.id])
    }
}

extension LoadProfileStoreTests {
    @Test("An edit can turn a sized job back into an exact one")
    @MainActor
    func editProfileCanClearTheSize() throws {
        let store = ProfileStoreFixture().store
        let added = try store.addProfile(NewProfile(name: "Oven", kind: .custom, energyKwh: 20, durationHours: 4,
                                                    size: .large, actionVerb: "Bake"))
        let exact = try store.editProfile(id: added.id, edit: ProfileEdit(
            energyKwh: 22, durationHours: 3.5, size: nil, updatesSize: true))
        #expect(exact.size == nil)
        #expect(exact.energyKwh == 22)
        #expect(exact.actionVerb == "Bake")
        let untouched = try store.editProfile(id: added.id, edit: ProfileEdit(energyKwh: 23, durationHours: 3.5))
        #expect(untouched.size == nil)
    }
}

extension LoadProfileStoreTests {
    @Test("A job's symbol is stored, edited, duplicated and trimmed")
    @MainActor
    func symbolIsStoredEditedAndDuplicated() throws {
        let fixture = ProfileStoreFixture()
        let added = try fixture.store.addProfile(NewProfile(
            name: "Hot tub", kind: .custom, energyKwh: 20, durationHours: 4, symbol: " bathtub.fill "))
        #expect(added.symbol == "bathtub.fill")
        #expect(LoadProfileStore(userDefaults: fixture.defaults).profile(id: added.id)?.symbol == "bathtub.fill")
        let edited = try fixture.store.editProfile(id: added.id, edit: ProfileEdit(
            energyKwh: 20, durationHours: 4, symbol: "flame.fill"))
        #expect(edited.symbol == "flame.fill")
        let kept = try fixture.store.editProfile(id: added.id, edit: ProfileEdit(energyKwh: 21, durationHours: 4))
        #expect(kept.symbol == "flame.fill")
        #expect(try fixture.store.duplicateProfile(id: added.id).symbol == "flame.fill")
        let blank = try fixture.store.addProfile(NewProfile(
            name: "Oven", kind: .custom, energyKwh: 3, durationHours: 1, symbol: "  "))
        #expect(blank.symbol == nil)
    }
}

extension LoadProfileStoreTests {
    @Test("A new car keeps the glyph picked for it")
    @MainActor
    func createCarProfileKeepsTheSymbol() throws {
        let store = ProfileStoreFixture().store
        let settings = try #require(store.profile(id: "car")?.carSettings)
        let withGlyph = try store.createCarProfile(name: "Leaf", settings: settings, symbol: "bolt.car.fill")
        #expect(withGlyph.symbol == "bolt.car.fill")
        #expect(try store.createCarProfile(name: "Bolt", settings: settings).symbol == nil)
    }
}
