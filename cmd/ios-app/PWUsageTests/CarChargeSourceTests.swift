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

    @Test("A store keeps an injected source, reads from it and stops hand edits")
    @MainActor
    func storeKeepsAnInjectedSource() throws {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults(), chargeSource: SyncedChargeSource(charge: 61))
        #expect(!store.chargeSource.isManual)
        #expect(!store.canEditCharge)
        let seeded = try #require(store.profile(id: "car"))
        #expect(store.currentCharge(for: seeded) == 61)
        #expect(seeded.carSettings?.initialStateOfCharge == 20)
    }

    @Test("With the manual source the displayed charge is the saved one")
    @MainActor
    func displayedChargeIsTheSavedChargeForManualSource() throws {
        let store = LoadProfileStore(userDefaults: Self.emptyDefaults())
        let seeded = try #require(store.profile(id: "car"))
        #expect(store.currentCharge(for: seeded) == 20)
    }

    private static func emptyDefaults() -> UserDefaults {
        let suiteName = "CarChargeSourceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
