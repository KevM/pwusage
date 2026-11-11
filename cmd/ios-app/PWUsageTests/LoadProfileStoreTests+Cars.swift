import Foundation
@testable import PWUsage
import Testing

extension LoadProfileStoreTests {
    @Test("Adds a second car with its own battery size")
    @MainActor
    func createsASecondCarWithItsOwnCapacity() throws {
        let fixture = ProfileStoreFixture()
        let small = CarLoadSettings(capacityKwh: 40, initialStateOfCharge: 30,
                                    targetStateOfCharge: 80, chargingLevel: .level1)
        let created = try fixture.store.createCarProfile(name: "  Leaf ", settings: small)
        #expect(created.kind == .car)
        #expect(created.name == "Leaf")
        #expect(UUID(uuidString: created.id) != nil)
        #expect(created.energyKwh > 0)
        #expect(created.durationHours > 0)
        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profile(id: "car")?.carSettings?.capacityKwh == 60)
        #expect(restored.profile(id: created.id)?.carSettings?.capacityKwh == 40)
        #expect(restored.profiles.last?.id == created.id)
    }

    @Test("Duplicates a job right after its source with a copy name")
    @MainActor
    func duplicateInsertsAfterSourceWithCopyName() throws {
        let store = ProfileStoreFixture().store
        let copy = try store.duplicateProfile(id: "car")
        #expect(copy.id != "car")
        #expect(UUID(uuidString: copy.id) != nil)
        #expect(copy.name == "Charge the car copy")
        #expect(copy.kind == .car)
        #expect(copy.carSettings == store.profile(id: "car")?.carSettings)
        #expect(store.profiles.map(\.id).prefix(2) == ["car", copy.id])
        #expect(throws: LoadProfileError.profileNotFound) { try store.duplicateProfile(id: "missing") }
    }

    @Test("Renames any kind of job")
    @MainActor
    func renamesAnyJob() throws {
        let store = ProfileStoreFixture().store
        _ = try store.editProfile(id: "dishwasher", name: "Dishwasher (garage)", energyKwh: 5, durationHours: 2)
        #expect(store.profile(id: "dishwasher")?.name == "Dishwasher (garage)")
        let car = try #require(store.profile(id: "car"))
        _ = try store.editProfile(id: "car", name: " Model Y ", energyKwh: car.energyKwh,
                                  durationHours: car.durationHours, carSettings: car.carSettings)
        #expect(store.profile(id: "car")?.name == "Model Y")
    }

    @Test("Rejects a blank name for any job")
    @MainActor
    func rejectsBlankNames() throws {
        let store = ProfileStoreFixture().store
        let settings = try #require(store.profile(id: "car")?.carSettings)
        #expect(throws: LoadProfileError.invalidProfile) {
            try store.createCarProfile(name: "   ", settings: settings)
        }
        #expect(throws: LoadProfileError.invalidProfile) {
            try store.editProfile(id: "dishwasher", name: " ", energyKwh: 5, durationHours: 2)
        }
    }

    @Test("Updates a car's charge in 5% steps and persists it")
    @MainActor
    func updateCarChargePersistsAndRecomputesEstimate() throws {
        let fixture = ProfileStoreFixture()
        try fixture.store.updateCarCharge(id: "car", current: 37, target: nil)
        let car = try #require(fixture.store.profile(id: "car"))
        #expect(car.carSettings?.initialStateOfCharge == 35)
        #expect(car.carSettings?.targetStateOfCharge == 80)
        #expect(car.energyKwh == 60 * 45 / 100)
        let restored = LoadProfileStore(userDefaults: fixture.defaults)
        #expect(restored.profile(id: "car")?.carSettings?.initialStateOfCharge == 35)
    }

    @Test("A full car keeps a valid job")
    @MainActor
    func fullCarStaysValid() throws {
        let store = ProfileStoreFixture().store
        try store.updateCarCharge(id: "car", current: 100, target: 100)
        #expect(store.profile(id: "car")?.carSettings?.initialStateOfCharge == 100)
        #expect(store.profile(id: "car")?.carSettings?.targetStateOfCharge == 100)
    }

    @Test("Charge updates reject unknown and non-car jobs")
    @MainActor
    func updateCarChargeRejectsOtherJobs() {
        let store = ProfileStoreFixture().store
        #expect(throws: LoadProfileError.invalidProfile) {
            try store.updateCarCharge(id: "dishwasher", current: 10, target: nil)
        }
        #expect(throws: LoadProfileError.profileNotFound) {
            try store.updateCarCharge(id: "missing", current: 10, target: nil)
        }
    }

    @Test("The last-used EV follows selection of cars only")
    @MainActor
    func lastEVFollowsSelectionOfCars() throws {
        let store = ProfileStoreFixture().store
        let leaf = try store.createCarProfile(name: "Leaf", settings: #require(store.profile(id: "car")?.carSettings))
        try store.selectProfile(id: leaf.id)
        #expect(store.lastEVProfileID == leaf.id)
        try store.selectProfile(id: "dishwasher")
        #expect(store.lastEVProfileID == leaf.id)
        #expect(store.carProfiles.map(\.id) == ["car", leaf.id])
    }

    @Test("Deleting the last-used EV falls back to another car, then to nothing")
    @MainActor
    func deletingLastEVFallsBackToAnotherCar() throws {
        let store = ProfileStoreFixture().store
        let leaf = try store.createCarProfile(name: "Leaf", settings: #require(store.profile(id: "car")?.carSettings))
        try store.selectProfile(id: leaf.id)
        try store.deleteProfile(id: leaf.id)
        #expect(store.lastEVProfileID == "car")
        try store.deleteProfile(id: "car")
        #expect(store.lastEVProfileID == nil)
        #expect(store.carProfiles.isEmpty)
    }

    @Test("Last-used EV persists, and an older payload derives one")
    @MainActor
    func lastEVPersistsAndOlderPayloadsDeriveOne() throws {
        let fixture = ProfileStoreFixture()
        let leaf = try fixture.store.createCarProfile(
            name: "Leaf", settings: #require(fixture.store.profile(id: "car")?.carSettings))
        try fixture.store.selectProfile(id: leaf.id)
        #expect(LoadProfileStore(userDefaults: fixture.defaults).lastEVProfileID == leaf.id)

        let defaults = ProfileStoreFixture.emptyDefaults()
        let saved = VersionOneCollection(version: 2, profiles: VersionOneCollection.builtIns,
                                         selectedProfileID: "dryer")
        defaults.set(try JSONEncoder().encode(saved), forKey: LoadProfileStore.storageKey)
        #expect(LoadProfileStore(userDefaults: defaults).lastEVProfileID == "car")
    }
}

extension LoadProfileStoreTests {
    @Test("Setting a car's charge to what it already is does not rewrite the jobs")
    @MainActor
    func unchangedChargeUpdateIsANoOp() throws {
        let store = ProfileStoreFixture().store
        var publishes = 0
        let subscription = store.$profiles.dropFirst().sink { _ in publishes += 1 }
        try store.updateCarCharge(id: "car", current: 20, target: 80)
        #expect(publishes == 0)
        try store.updateCarCharge(id: "car", current: 25, target: nil)
        #expect(publishes == 1)
        subscription.cancel()
    }
}

extension LoadProfileStoreTests {
    @Test("A car that is already at its target can still be added")
    @MainActor
    func createsACarAlreadyAtItsTarget() throws {
        let fixture = ProfileStoreFixture()
        let full = CarLoadSettings(capacityKwh: 75, initialStateOfCharge: 100,
                                   targetStateOfCharge: 100, chargingLevel: .level2)
        let created = try fixture.store.createCarProfile(name: "Model Y", settings: full)
        #expect(created.carSettings == full)
        #expect(created.energyKwh > 0)
        #expect(created.durationHours > 0)
        #expect(LoadProfileStore(userDefaults: fixture.defaults).profile(id: created.id)?.carSettings == full)
    }
}
