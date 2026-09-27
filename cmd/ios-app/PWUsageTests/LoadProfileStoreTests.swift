import Foundation
import Testing
@testable import PWUsage

@Suite("Load Profile Store Tests")
struct LoadProfileStoreTests {
    @Test("Seeds built-in profiles and the removable Custom example")
    @MainActor
    func seedsDefaults() {
        let store = Fixture().store
        #expect(store.profiles.map(\.id) == ["car", "dishwasher", "washer", "dryer", "washer-dryer-combo", "custom-example"])
        #expect(store.profile(id: "car")?.carSettings?.capacityKwh == 60)
        #expect(store.profile(id: "car")?.carSettings?.initialStateOfCharge == 20)
        #expect(store.profile(id: "car")?.carSettings?.targetStateOfCharge == 80)
        #expect(store.profile(id: "car")?.carSettings?.chargingLevel == .level2)
        #expect(store.profile(id: "dishwasher")?.energyKwh == 5)
        #expect(store.profile(id: "washer-dryer-combo")?.energyKwh == 8)
        #expect(store.profile(id: "custom-example")?.energyKwh == 20)
    }

    @Test("Creates, renames, edits, and deletes custom loads")
    @MainActor
    func managesCustomLoads() throws {
        let store = Fixture().store
        let created = try store.createCustomProfile(name: "Pool pump", energyKwh: 4, durationHours: 2)
        #expect(UUID(uuidString: created.id) != nil)
        let edited = try store.editProfile(id: created.id, name: "Pool pump (summer)", energyKwh: 5, durationHours: 3)
        #expect(edited.name == "Pool pump (summer)")
        #expect(edited.energyKwh == 5)
        #expect(edited.durationHours == 3)
        try store.deleteCustomProfile(id: created.id)
        #expect(store.profile(id: created.id) == nil)
    }

    @Test("Edits and resets built-in profiles")
    @MainActor
    func editsAndResetsBuiltIns() throws {
        let store = Fixture().store
        _ = try store.editProfile(id: "dishwasher", name: "Dishwasher", energyKwh: 6, durationHours: 4)
        #expect(store.profile(id: "dishwasher")?.energyKwh == 6)
        try store.resetBuiltInProfile(id: "dishwasher")
        #expect(store.profile(id: "dishwasher")?.energyKwh == 5)
        #expect(throws: LoadProfileError.self) { try store.resetBuiltInProfile(id: "custom-example") }
    }

    @Test("Persists selection and profile changes across store instances")
    @MainActor
    func persistsSelectionAndEdits() throws {
        let fixture = Fixture()
        let store = fixture.store
        let created = try store.createCustomProfile(name: "Oven", energyKwh: 3, durationHours: 1)
        try store.selectProfile(id: created.id)
        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.selectedProfileID == created.id)
        #expect(restored.profile(id: created.id) == created)
    }

    @Test("Reorders built-in and custom profiles together without changing selection")
    @MainActor
    func reordersAllProfilesAcrossKinds() throws {
        let fixture = Fixture()
        let store = fixture.store
        let custom = try store.createCustomProfile(name: "Pool pump", energyKwh: 4, durationHours: 2)
        try store.selectProfile(id: "washer")
        let customIndex = try #require(store.profiles.firstIndex(where: { $0.id == custom.id }))

        store.moveProfiles(fromOffsets: IndexSet(integer: customIndex), toOffset: 0)

        #expect(store.profiles.first?.id == custom.id)
        #expect(store.selectedProfileID == "washer")
        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profiles.map(\.id) == store.profiles.map(\.id))
        #expect(restored.selectedProfileID == "washer")
    }

    @Test("Clamps an earlier Car capacity without losing other saved profiles")
    @MainActor
    func preservesProfilesWhenOlderCarCapacityExceedsHorizon() throws {
        let fixture = Fixture()
        let custom = try fixture.store.createCustomProfile(name: "Pool pump", energyKwh: 4, durationHours: 2)
        try fixture.store.selectProfile(id: custom.id)
        let data = try #require(fixture.defaults.data(forKey: LoadProfileStore.storageKey))
        var payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var profiles = try #require(payload["profiles"] as? [[String: Any]])
        let carIndex = try #require(profiles.firstIndex(where: { $0["id"] as? String == "car" }))
        var car = profiles[carIndex]
        var settings = try #require(car["carSettings"] as? [String: Any])
        settings["capacityKwh"] = 250.0
        car["carSettings"] = settings
        profiles[carIndex] = car
        payload["profiles"] = profiles
        fixture.defaults.set(try JSONSerialization.data(withJSONObject: payload), forKey: LoadProfileStore.storageKey)

        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profile(id: "car")?.carSettings?.capacityKwh == LoadProfile.maximumCarCapacityKwh)
        #expect(restored.profile(id: custom.id) != nil)
        #expect(restored.selectedProfileID == custom.id)
    }

    @Test("Keeps the removable Custom example deleted after reopening")
    @MainActor
    func deletionOfCustomExampleSurvivesReinitialization() throws {
        let fixture = Fixture()
        try fixture.store.deleteCustomProfile(id: "custom-example")
        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profile(id: "custom-example") == nil)
    }

    @Test("Recovers when a reserved profile ID is saved with the wrong kind")
    @MainActor
    func recoversReservedIDKindMismatch() throws {
        let fixture = Fixture()
        let saved = try #require(fixture.defaults.data(forKey: LoadProfileStore.storageKey))
        var json = try #require(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        var profiles = try #require(json["profiles"] as? [[String: Any]])
        let index = try #require(profiles.firstIndex(where: { $0["id"] as? String == "custom-example" }))
        profiles[index]["kind"] = "appliance"
        json["profiles"] = profiles
        fixture.defaults.set(try JSONSerialization.data(withJSONObject: json), forKey: LoadProfileStore.storageKey)

        let recovered = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(recovered.profile(id: "custom-example")?.kind == .custom)
        #expect(recovered.profile(id: "custom-example")?.energyKwh == 20)
    }

    @Test("Rejects malformed values and recovers malformed saved data")
    @MainActor
    func validatesAndRecovers() throws {
        let fixture = Fixture()
        fixture.defaults.set(Data("not-json".utf8), forKey: LoadProfileStore.storageKey)
        let store = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(store.profile(id: "dishwasher")?.energyKwh == 5)
        #expect(throws: LoadProfileError.self) { try store.createCustomProfile(name: "  ", energyKwh: 2, durationHours: 1) }
        #expect(throws: LoadProfileError.self) { try store.createCustomProfile(name: "Bad", energyKwh: .infinity, durationHours: 1) }
        #expect(throws: LoadProfileError.self) { try store.createCustomProfile(name: "Bad", energyKwh: 2, durationHours: 0) }
        var invalidCar = try #require(store.profile(id: "car"))
        invalidCar.carSettings?.targetStateOfCharge = -1
        #expect(throws: LoadProfileError.self) { try store.updateProfile(invalidCar) }
        invalidCar.carSettings = CarLoadSettings(capacityKwh: 201, initialStateOfCharge: 0, targetStateOfCharge: 100, chargingLevel: .level1)
        #expect(throws: LoadProfileError.self) { try store.updateProfile(invalidCar) }
        var changedKind = try #require(store.profile(id: "dishwasher"))
        changedKind = LoadProfile(id: changedKind.id, name: changedKind.name, kind: .custom, energyKwh: changedKind.energyKwh, durationHours: changedKind.durationHours, carSettings: nil)
        #expect(throws: LoadProfileError.self) { try store.updateProfile(changedKind) }
    }

    @Test("Trims names and validates SOC ordering and range")
    @MainActor
    func trimsNamesAndValidatesCarSettings() throws {
        let store = Fixture().store
        let created = try store.createCustomProfile(name: "  Workshop  ", energyKwh: 2, durationHours: 1)
        #expect(created.name == "Workshop")
        var car = try #require(store.profile(id: "car"))
        car.carSettings?.initialStateOfCharge = 81
        #expect(throws: LoadProfileError.self) { try store.updateProfile(car) }
    }
}

@MainActor
private struct Fixture {
    let defaults: UserDefaults
    let store: LoadProfileStore

    init() {
        let suiteName = "LoadProfileStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        store = LoadProfileStore(userDefaults: defaults)
    }
}
