import Combine
import Foundation

@MainActor
final class LoadProfileStore: ObservableObject {
    static let storageKey = "pwusage.loadProfiles.v1"
    static let schemaVersion = 2

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
    @Published private(set) var selectedProfileID: String

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        if let saved = Self.loadCollection(from: userDefaults) {
            profiles = saved.profiles
            selectedProfileID = saved.selectedProfileID.flatMap { id in
                saved.profiles.contains(where: { $0.id == id }) ? id : nil
            } ?? Self.defaultProfiles[0].id
        } else {
            profiles = Self.defaultProfiles
            selectedProfileID = Self.defaultProfiles[0].id
        }
        persist()
    }

    func profile(id: String) -> LoadProfile? {
        profiles.first { $0.id == id }
    }

    @discardableResult
    func createCustomProfile(name: String, energyKwh: Double, durationHours: Double) throws -> LoadProfile {
        let profile = LoadProfile(
            id: UUID().uuidString,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            kind: .custom,
            energyKwh: energyKwh,
            durationHours: durationHours,
            carSettings: nil
        )
        try Self.validate(profile)
        profiles.append(profile)
        persist()
        return profile
    }

    @discardableResult
    func editProfile(id: String, name: String? = nil, energyKwh: Double, durationHours: Double, carSettings: CarLoadSettings? = nil) throws -> LoadProfile {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        var updated = profiles[index]
        if updated.kind == .custom, let name {
            updated.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        updated.energyKwh = energyKwh
        updated.durationHours = durationHours
        if updated.kind == .car {
            updated.carSettings = carSettings ?? updated.carSettings
        }
        try Self.validate(updated)
        profiles[index] = updated
        persist()
        return updated
    }

    func deleteCustomProfile(id: String) throws {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        guard profiles[index].kind == .custom else { throw LoadProfileError.cannotDeleteBuiltIn }
        profiles.remove(at: index)
        if selectedProfileID == id { selectedProfileID = Self.defaultProfiles[0].id }
        persist()
    }

    func resetBuiltInProfile(id: String) throws {
        guard let defaults = Self.defaultProfiles.first(where: { $0.id == id }), defaults.kind != .custom else {
            throw LoadProfileError.cannotResetCustom
        }
        guard let index = profiles.firstIndex(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        profiles[index] = defaults
        persist()
    }

    func selectProfile(id: String) throws {
        guard profiles.contains(where: { $0.id == id }) else { throw LoadProfileError.profileNotFound }
        selectedProfileID = id
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
        let collection = PersistedCollection(version: Self.schemaVersion, profiles: profiles, selectedProfileID: selectedProfileID)
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
                  settings.capacityKwh <= 250 else { continue }
            settings.capacityKwh = LoadProfile.maximumCarCapacityKwh
            profiles[index].carSettings = settings
        }
        let normalized = PersistedCollection(version: schemaVersion, profiles: profiles, selectedProfileID: saved.selectedProfileID)
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
        guard Set(ids).count == ids.count,
              defaultProfiles.filter({ $0.kind != .custom }).allSatisfy({ defaults in collection.profiles.contains(where: { $0.id == defaults.id && $0.kind == defaults.kind }) }),
              collection.profiles.allSatisfy({ profile in
                  if let reservedProfile = defaultProfiles.first(where: { $0.id == profile.id }) {
                      return reservedProfile.kind == profile.kind
                  }
                  return profile.kind == .custom && UUID(uuidString: profile.id) != nil
              }) else { return false }
        return collection.profiles.allSatisfy { (try? validate($0)) != nil }
    }

    private static func validate(_ profile: LoadProfile) throws {
        guard profile.energyKwh.isFinite, profile.energyKwh > 0,
              profile.durationHours.isFinite, profile.durationHours > 0 else {
            throw LoadProfileError.invalidProfile
        }
        if profile.kind == .custom && profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw LoadProfileError.invalidProfile
        }
        if profile.kind == .car {
            guard let settings = profile.carSettings,
                  settings.capacityKwh.isFinite, settings.capacityKwh > 0,
                  settings.capacityKwh <= LoadProfile.maximumCarCapacityKwh,
                  settings.initialStateOfCharge.isFinite, (0 ... 100).contains(settings.initialStateOfCharge),
                  // swiftlint:disable:next line_length
                  settings.targetStateOfCharge.isFinite, (settings.initialStateOfCharge ... 100).contains(settings.targetStateOfCharge) else {
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
    }

    private static let defaultProfiles: [LoadProfile] = [
        LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: Defaults.carEnergyKwh, durationHours: Defaults.carDurationHours, carSettings: CarLoadSettings(capacityKwh: Defaults.carCapacityKwh, initialStateOfCharge: Defaults.carInitialSOC, targetStateOfCharge: Defaults.carTargetSOC, chargingLevel: Defaults.carLevel)),
        LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: Defaults.dishwasherKwh, durationHours: Defaults.dishwasherHours, carSettings: nil),
        LoadProfile(id: "washer", name: "Wash the laundry", kind: .appliance, energyKwh: Defaults.washerKwh, durationHours: Defaults.washerHours, carSettings: nil),
        LoadProfile(id: "dryer", name: "Dry the laundry", kind: .appliance, energyKwh: Defaults.dryerKwh, durationHours: Defaults.dryerHours, carSettings: nil),
        LoadProfile(id: "washer-dryer-combo", name: "Wash and dry the laundry", kind: .appliance, energyKwh: Defaults.comboKwh, durationHours: Defaults.comboHours, carSettings: nil),
        LoadProfile(id: customExampleID, name: "Bake bread", kind: .custom, energyKwh: Defaults.customExampleKwh, durationHours: Defaults.customExampleHours, carSettings: nil)
    ]
}
