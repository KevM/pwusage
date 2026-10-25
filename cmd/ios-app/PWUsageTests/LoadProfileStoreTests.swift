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
        #expect(throws: LoadProfileError.self) {
            try store.editProfile(id: "car", energyKwh: invalidCar.energyKwh, durationHours: invalidCar.durationHours,
                                  carSettings: invalidCar.carSettings)
        }
        invalidCar.carSettings = CarLoadSettings(capacityKwh: 201, initialStateOfCharge: 0, targetStateOfCharge: 100, chargingLevel: .level1)
        #expect(throws: LoadProfileError.self) {
            try store.editProfile(id: "car", energyKwh: invalidCar.energyKwh, durationHours: invalidCar.durationHours,
                                  carSettings: invalidCar.carSettings)
        }
    }

    @Test("Trims names and validates SOC ordering and range")
    @MainActor
    func trimsNamesAndValidatesCarSettings() throws {
        let store = Fixture().store
        let created = try store.createCustomProfile(name: "  Workshop  ", energyKwh: 2, durationHours: 1)
        #expect(created.name == "Workshop")
        var car = try #require(store.profile(id: "car"))
        car.carSettings?.initialStateOfCharge = 81
        #expect(throws: LoadProfileError.self) {
            try store.editProfile(id: "car", energyKwh: car.energyKwh, durationHours: car.durationHours,
                                  carSettings: car.carSettings)
        }
    }

    @Test("Fresh installs name every Job as a verb phrase")
    @MainActor
    func freshInstallUsesVerbNames() {
        let store = Fixture().store
        #expect(store.profiles.map(\.name) == ["Charge the car", "Wash the dishes", "Wash the laundry", "Dry the laundry", "Wash and dry the laundry", "Bake bread"])
    }

    @Test("Version 1 built-in names migrate to verb phrases without touching custom Jobs or settings")
    @MainActor
    func migratesVersionOneBuiltInNames() throws {
        let defaults = Fixture.emptyDefaults()
        let poolPumpID = UUID().uuidString
        let car = CarLoadSettings(capacityKwh: 75, initialStateOfCharge: 30, targetStateOfCharge: 90, chargingLevel: .level1)
        let saved = VersionOneCollection(version: 1, profiles: [
            LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 36, durationHours: 4, carSettings: car),
            LoadProfile(id: "dishwasher", name: "Dishwasher", kind: .appliance, energyKwh: 6, durationHours: 3, carSettings: nil),
            LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 2, durationHours: 1.5, carSettings: nil),
            LoadProfile(id: "dryer", name: "Dryer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil),
            LoadProfile(id: "washer-dryer-combo", name: "Washer–Dryer Combo", kind: .appliance, energyKwh: 8, durationHours: 3, carSettings: nil),
            LoadProfile(id: poolPumpID, name: "Pool pump", kind: .custom, energyKwh: 4, durationHours: 2, carSettings: nil),
        ], selectedProfileID: "dryer")
        defaults.set(try JSONEncoder().encode(saved), forKey: LoadProfileStore.storageKey)

        let store = LoadProfileStore(userDefaults: defaults)

        #expect(store.profiles.map(\.name) == ["Charge the car", "Wash the dishes", "Wash the laundry", "Dry the laundry", "Wash and dry the laundry", "Pool pump"])
        #expect(store.selectedProfileID == "dryer")
        #expect(store.profile(id: "car")?.carSettings == car)
        #expect(store.profile(id: "dishwasher")?.energyKwh == 6)
        #expect(store.profile(id: "dishwasher")?.durationHours == 3)
        let persisted = try #require(defaults.data(forKey: LoadProfileStore.storageKey))
        #expect(try JSONDecoder().decode(VersionOneCollection.self, from: persisted).version == 2)
    }

    @Test("The seeded Custom example is renamed only while it keeps its seeded name")
    @MainActor
    func renamesSeededCustomExampleOnlyWhileUnchanged() throws {
        for (savedName, expected) in [("Custom", "Bake bread"), ("Hot tub", "Hot tub")] {
            let defaults = Fixture.emptyDefaults()
            let saved = VersionOneCollection(version: 1, profiles: VersionOneCollection.builtIns + [
                LoadProfile(id: "custom-example", name: savedName, kind: .custom, energyKwh: 20, durationHours: 4, carSettings: nil),
            ], selectedProfileID: nil)
            defaults.set(try JSONEncoder().encode(saved), forKey: LoadProfileStore.storageKey)

            let store = LoadProfileStore(userDefaults: defaults)

            #expect(store.profile(id: "custom-example")?.name == expected)
        }
    }

    @Test("Describes every profile failure in user-facing language")
    func describesProfileErrors() {
        let cases: [(LoadProfileError, String)] = [
            (.invalidProfile, "Enter a name for custom loads, and energy and duration greater than zero. Check the car charge settings too."),
            (.profileNotFound, "That load profile is no longer available. Close and reopen load profiles."),
            (.cannotDeleteBuiltIn, "Built-in load profiles can’t be deleted. Edit them instead, or reset them to their default settings."),
            (.cannotResetCustom, "Custom loads can’t be reset to defaults. Delete the load and add it again instead.")
        ]
        for (error, expected) in cases {
            #expect(error.errorDescription == expected)
            #expect(error.localizedDescription == expected)
        }
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

    /// A fixture whose defaults hold nothing yet, so a test can seed saved data before the store reads it.
    static func emptyDefaults() -> UserDefaults {
        let suiteName = "LoadProfileStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}

/// The persisted shape written by schema version 1, before Jobs were named as verb phrases.
private struct VersionOneCollection: Codable {
    let version: Int
    let profiles: [LoadProfile]
    let selectedProfileID: String?

    static let builtIns: [LoadProfile] = [
        LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 36, durationHours: 4, carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level2)),
        LoadProfile(id: "dishwasher", name: "Dishwasher", kind: .appliance, energyKwh: 5, durationHours: 2, carSettings: nil),
        LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 2, durationHours: 1.5, carSettings: nil),
        LoadProfile(id: "dryer", name: "Dryer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil),
        LoadProfile(id: "washer-dryer-combo", name: "Washer–Dryer Combo", kind: .appliance, energyKwh: 8, durationHours: 3, carSettings: nil),
    ]
}
