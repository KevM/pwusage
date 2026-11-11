import Foundation
@testable import PWUsage
import Testing

/// A source that mimics a later vehicle sync: it reports its own charge and the person can't edit it.
private struct SyncedChargeSource: CarChargeSource {
    let charge: Double
    var isManual: Bool { false }
    func currentCharge(for car: LoadProfile) -> Double? { car.kind == .car ? charge : nil }
}

@Suite("Car charge source")
struct CarChargeSourceTests {
    private let car = LoadProfile(
        id: "car", name: "Model Y", kind: .car, energyKwh: 30, durationHours: 3,
        carSettings: CarLoadSettings(capacityKwh: 75, initialStateOfCharge: 35,
                                     targetStateOfCharge: 80, chargingLevel: .level2))

    @Test("The manual source reads the saved charge")
    func manualSourceReadsTheSavedCharge() {
        let source = ManualCarChargeSource()
        #expect(source.currentCharge(for: car) == 35)
        let washer = LoadProfile(id: "washer", name: "Wash", kind: .appliance, energyKwh: 2, durationHours: 1.5,
                                 carSettings: nil)
        #expect(source.currentCharge(for: washer) == nil)
    }

    @Test("The manual source is editable by hand")
    func manualSourceIsManual() {
        #expect(ManualCarChargeSource().isManual)
    }

    @Test("A store uses the manual source unless given another")
    @MainActor
    func storeDefaultsToTheManualSource() {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults())
        #expect(store.chargeSource.isManual)
        #expect(store.canEditCharge)
    }

    @Test("A store keeps an injected source and stops hand edits")
    @MainActor
    func storeKeepsAnInjectedSource() {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults(), chargeSource: SyncedChargeSource(charge: 61))
        #expect(!store.chargeSource.isManual)
        #expect(!store.canEditCharge)
    }

    @Test("Syncing writes the source's charge into the saved car and keeps the target above it")
    @MainActor
    func syncWritesTheStoredCharge() throws {
        let defaults = Self.emptyDefaults()
        let store = LoadProfileStore(userDefaults: defaults, chargeSource: SyncedChargeSource(charge: 85))
        store.syncChargesFromSource()
        let car = try #require(store.profile(id: "car"))
        #expect(car.carSettings?.initialStateOfCharge == 85)
        #expect(car.carSettings?.targetStateOfCharge == 85)
        #expect(LoadProfileStore(userDefaults: defaults).profile(id: "car")?.carSettings?.initialStateOfCharge == 85)
    }

    @Test("Syncing does nothing for the manual source")
    @MainActor
    func syncIsANoOpForManualSource() {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults())
        let before = store.profiles
        store.syncChargesFromSource()
        #expect(store.profiles == before)
    }

    @Test("Syncing clamps a wild value into 0 to 100")
    @MainActor
    func syncClampsTheSourceValue() throws {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults(), chargeSource: SyncedChargeSource(charge: 140))
        store.syncChargesFromSource()
        #expect(store.profile(id: "car")?.carSettings?.initialStateOfCharge == 100)
    }

    private static func emptyDefaults() -> UserDefaults {
        let suiteName = "CarChargeSourceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
