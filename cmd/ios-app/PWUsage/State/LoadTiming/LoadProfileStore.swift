import Combine
import Foundation

@MainActor
final class LoadProfileStore: ObservableObject {
    static let storageKey = "pwusage.loadProfiles.v1"
    static let schemaVersion = 3
    /// Payloads written before the 200 kWh cap could reach this value; clamp those
    /// into range instead of discarding every profile. Larger values fail validation.
    private static let maximumLegacyCarCapacityKwh = 250.0

    // All seeded example values live here so the defaults remain easy to review and adjust.
    enum Defaults {
        static let carCapacityKwh = 60.0
        static let carInitialSOC = 20.0
        static let carTargetSOC = 80.0
        static let carLevel: CarChargingLevel = .level2
        static let carEnergyKwh = 36.0
        static let carDurationHours = 4.0
        static let dishwasherKwh = 5.0
        static let dishwasherHours = 2.0
        static let washerKwh = 2.0
        static let washerHours = 1.5
        static let dryerKwh = 3.0
        static let dryerHours = 1.0
        static let comboKwh = 8.0
        static let comboHours = 3.0
        static let customExampleKwh = 20.0
        static let customExampleHours = 4.0
    }

    @Published private(set) var profiles: [LoadProfile]
    @Published private(set) var selectedProfileID: String?
    @Published private(set) var lastEVProfileID: String?

    private let userDefaults: UserDefaults
    let chargeSource: any CarChargeSource

    init(userDefaults: UserDefaults = .standard, chargeSource: any CarChargeSource = ManualCarChargeSource()) {
        self.userDefaults = userDefaults
        self.chargeSource = chargeSource
        let saved = Self.loadCollection(from: userDefaults)
        if let saved {
            profiles = saved.profiles
            selectedProfileID = saved.selectedProfileID.flatMap { id in
                saved.profiles.contains(where: { $0.id == id }) ? id : nil
            } ?? saved.profiles.first?.id
        } else {
            profiles = Self.defaultProfiles
            selectedProfileID = Self.defaultProfiles.first?.id
        }
        lastEVProfileID = Self.resolvedLastEVID(
            saved: saved?.lastEVProfileID, profiles: profiles,
            selectedID: selectedProfileID)
        persist()
    }

    func profile(id: String) -> LoadProfile? {
        profiles.first { $0.id == id }
    }

    var carProfiles: [LoadProfile] { profiles.filter { $0.kind == .car } }

    /// False when the charge comes from somewhere other than the person, so the app shouldn't offer to edit it.
    var canEditCharge: Bool { chargeSource.isManual }

    @discardableResult
    func addProfile(_ new: NewProfile) throws -> LoadProfile {
        let profile = LoadProfile(
            id: UUID().uuidString,
            name: new.name.trimmingCharacters(in: .whitespacesAndNewlines),
            kind: new.kind,
            energyKwh: new.energyKwh,
            durationHours: new.durationHours,
            carSettings: new.carSettings,
            size: new.size,
            actionVerb: Self.trimmedVerb(new.actionVerb)
        )
        try Self.validate(profile)
        profiles.append(profile)
        persist()
        return profile
    }

    @discardableResult
    func createCustomProfile(name: String, energyKwh: Double, durationHours: Double) throws -> LoadProfile {
        try addProfile(NewProfile(name: name, kind: .custom, energyKwh: energyKwh, durationHours: durationHours))
    }

    @discardableResult
    func createCarProfile(name: String, settings: CarLoadSettings) throws -> LoadProfile {
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) else {
            throw LoadProfileError.invalidProfile
        }
        // A car already at its target adds no energy; the stored fields only need to stay valid.
        return try addProfile(NewProfile(
            name: name, kind: .car,
            energyKwh: estimate.batteryKwh > 0 ? estimate.batteryKwh : Defaults.carEnergyKwh,
            durationHours: estimate.batteryKwh > 0 ? estimate.durationHours : Defaults.carDurationHours,
            carSettings: settings))
    }

    @discardableResult
    func duplicateProfile(id: String) throws -> LoadProfile {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        let source = profiles[index]
        let copy = LoadProfile(
            id: UUID().uuidString, name: "\(source.name) copy", kind: source.kind,
            energyKwh: source.energyKwh, durationHours: source.durationHours, carSettings: source.carSettings,
            size: source.size, actionVerb: source.actionVerb)
        profiles.insert(copy, at: index + 1)
        persist()
        return copy
    }

    @discardableResult
    func editProfile(
        id: String, name: String? = nil, energyKwh: Double, durationHours: Double,
        carSettings: CarLoadSettings? = nil
    ) throws -> LoadProfile {
        try editProfile(id: id, edit: ProfileEdit(
            name: name, energyKwh: energyKwh, durationHours: durationHours, carSettings: carSettings))
    }

    @discardableResult
    func editProfile(id: String, edit: ProfileEdit) throws -> LoadProfile {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        var updated = profiles[index]
        if let name = edit.name {
            updated.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        updated.energyKwh = edit.energyKwh
        updated.durationHours = edit.durationHours
        if let size = edit.size { updated.size = size }
        if let actionVerb = edit.actionVerb { updated.actionVerb = Self.trimmedVerb(actionVerb) }
        if updated.kind == .car {
            updated.carSettings = edit.carSettings ?? updated.carSettings
        }
        try Self.validate(updated)
        profiles[index] = updated
        persist()
        return updated
    }

    func deleteProfile(id: String) throws {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        profiles.remove(at: index)
        if selectedProfileID == id { selectedProfileID = profiles.first?.id }
        if lastEVProfileID == id {
            lastEVProfileID = Self.resolvedLastEVID(saved: nil, profiles: profiles, selectedID: selectedProfileID)
        }
        persist()
    }

    func selectProfile(id: String) throws {
        guard let profile = profile(id: id) else { throw LoadProfileError.profileNotFound }
        selectedProfileID = id
        if profile.kind == .car { lastEVProfileID = id }
        persist()
    }

    /// Brings every car's saved charge in line with the charge source. A manual source has nothing to
    /// bring in, so this does nothing until a vehicle sync supplies its own values.
    func syncChargesFromSource() {
        guard !chargeSource.isManual else { return }
        var changed = false
        for index in profiles.indices {
            guard var settings = profiles[index].carSettings,
                  let value = chargeSource.currentCharge(for: profiles[index]), value.isFinite else { continue }
            let charge = min(100, max(0, value))
            guard charge != settings.initialStateOfCharge else { continue }
            settings.initialStateOfCharge = charge
            settings.targetStateOfCharge = max(settings.targetStateOfCharge, charge)
            profiles[index].carSettings = settings
            changed = true
        }
        if changed { persist() }
    }

    func updateCarCharge(id: String, current: Double?, target: Double?) throws {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        var updated = profiles[index]
        guard updated.kind == .car, var settings = updated.carSettings else { throw LoadProfileError.invalidProfile }
        if let current { settings = CarChargeSteps.settings(settings, settingCurrent: current) }
        if let target { settings = CarChargeSteps.settings(settings, settingTarget: target) }
        guard settings != updated.carSettings else { return }
        updated.carSettings = settings
        if let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings), estimate.batteryKwh > 0 {
            updated.energyKwh = estimate.batteryKwh
            updated.durationHours = estimate.durationHours
        }
        try Self.validate(updated)
        profiles[index] = updated
        persist()
    }

    func moveProfiles(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        guard !offsets.isEmpty, (0 ... profiles.count).contains(destination),
              offsets.allSatisfy({ profiles.indices.contains($0) }) else { return }
        let moving = profiles.enumerated().compactMap { offsets.contains($0.offset) ? $0.element : nil }
        var reordered = profiles.enumerated().compactMap { offsets.contains($0.offset) ? nil : $0.element }
        let adjustedDestination = destination - offsets.filter { $0 < destination }.count
        reordered.insert(contentsOf: moving, at: adjustedDestination)
        profiles = reordered
        persist()
    }

    private func persist() {
        let collection = PersistedCollection(
            version: Self.schemaVersion, profiles: profiles, selectedProfileID: selectedProfileID,
            lastEVProfileID: lastEVProfileID)
        guard let data = try? JSONEncoder().encode(collection) else { return }
        userDefaults.set(data, forKey: Self.storageKey)
    }

    private static func loadCollection(from userDefaults: UserDefaults) -> PersistedCollection? {
        guard let data = userDefaults.data(forKey: storageKey),
              let saved = try? JSONDecoder().decode(PersistedCollection.self, from: data),
              (1 ... schemaVersion).contains(saved.version) else { return nil }

        var profiles = saved.profiles
        if saved.version == 1 {
            profiles = profiles.map(renamedForVersionTwo)
        }
        for index in profiles.indices where profiles[index].kind == .car {
            guard var settings = profiles[index].carSettings,
                  settings.capacityKwh > LoadProfile.maximumCarCapacityKwh,
                  settings.capacityKwh <= maximumLegacyCarCapacityKwh else { continue }
            settings.capacityKwh = LoadProfile.maximumCarCapacityKwh
            profiles[index].carSettings = settings
        }
        let normalized = PersistedCollection(
            version: schemaVersion, profiles: profiles, selectedProfileID: saved.selectedProfileID,
            lastEVProfileID: saved.lastEVProfileID)
        return isValidCollection(normalized) ? normalized : nil
    }

    /// Version 2 names Jobs as verb phrases ("Charge the car"). Built-ins can't be renamed, so they
    /// always take the new default name; custom Jobs keep theirs, except the seeded example while it
    /// still carries its seeded name.
    private static func renamedForVersionTwo(_ profile: LoadProfile) -> LoadProfile {
        var renamed = profile
        if profile.kind != .custom, let defaults = defaultProfiles.first(where: { $0.id == profile.id }) {
            renamed.name = defaults.name
        } else if profile.id == customExampleID, profile.name == versionOneCustomExampleName,
                  let defaults = defaultProfiles.first(where: { $0.id == customExampleID }) {
            renamed.name = defaults.name
        }
        return renamed
    }

    private static let customExampleID = "custom-example"
    private static let versionOneCustomExampleName = "Custom"

    private static func isValidCollection(_ collection: PersistedCollection) -> Bool {
        let ids = collection.profiles.map(\.id)
        return Set(ids).count == ids.count
            && collection.profiles.allSatisfy { (try? validate($0)) != nil }
    }

    private static func trimmedVerb(_ verb: String?) -> String? {
        guard let trimmed = verb?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func validate(_ profile: LoadProfile) throws {
        if profile.size != nil && profile.kind != .custom { throw LoadProfileError.invalidProfile }
        guard profile.energyKwh.isFinite, profile.energyKwh > 0,
              profile.durationHours.isFinite, profile.durationHours > 0 else {
            throw LoadProfileError.invalidProfile
        }
        if profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw LoadProfileError.invalidProfile
        }
        if profile.kind == .car {
            guard let settings = profile.carSettings,
                  settings.capacityKwh.isFinite, settings.capacityKwh > 0,
                  settings.capacityKwh <= LoadProfile.maximumCarCapacityKwh,
                  settings.initialStateOfCharge.isFinite, (0 ... 100).contains(settings.initialStateOfCharge),
                  settings.targetStateOfCharge.isFinite,
                  (settings.initialStateOfCharge ... 100).contains(settings.targetStateOfCharge) else {
                throw LoadProfileError.invalidProfile
            }
        } else if profile.carSettings != nil {
            throw LoadProfileError.invalidProfile
        }
    }

    private struct PersistedCollection: Codable {
        let version: Int
        let profiles: [LoadProfile]
        let selectedProfileID: String?
        var lastEVProfileID: String?
    }

    /// A saved last EV that still exists wins; otherwise the selected job if it is a car, else the first car.
    private static func resolvedLastEVID(saved: String?, profiles: [LoadProfile], selectedID: String?) -> String? {
        let cars = profiles.filter { $0.kind == .car }
        if let saved, cars.contains(where: { $0.id == saved }) { return saved }
        if let selectedID, cars.contains(where: { $0.id == selectedID }) { return selectedID }
        return cars.first?.id
    }

    private static let defaultProfiles: [LoadProfile] = [
        LoadProfile(
            id: "car", name: "Charge the car", kind: .car, energyKwh: Defaults.carEnergyKwh,
            durationHours: Defaults.carDurationHours,
            carSettings: CarLoadSettings(
                capacityKwh: Defaults.carCapacityKwh, initialStateOfCharge: Defaults.carInitialSOC,
                targetStateOfCharge: Defaults.carTargetSOC, chargingLevel: Defaults.carLevel)),
        LoadProfile(
            id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: Defaults.dishwasherKwh,
            durationHours: Defaults.dishwasherHours, carSettings: nil),
        LoadProfile(
            id: "washer", name: "Wash the laundry", kind: .appliance, energyKwh: Defaults.washerKwh,
            durationHours: Defaults.washerHours, carSettings: nil),
        LoadProfile(
            id: "dryer", name: "Dry the laundry", kind: .appliance, energyKwh: Defaults.dryerKwh,
            durationHours: Defaults.dryerHours, carSettings: nil),
        LoadProfile(
            id: "washer-dryer-combo", name: "Wash and dry the laundry", kind: .appliance,
            energyKwh: Defaults.comboKwh, durationHours: Defaults.comboHours, carSettings: nil),
        LoadProfile(
            id: customExampleID, name: "Bake bread", kind: .custom,
            energyKwh: Defaults.customExampleKwh, durationHours: Defaults.customExampleHours, carSettings: nil)
    ]
}
