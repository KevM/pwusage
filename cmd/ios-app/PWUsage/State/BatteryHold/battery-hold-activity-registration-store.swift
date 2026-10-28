import Foundation

/// Registrations this device made, so the app can unregister them after a
/// dismissal it did not observe. Stores a digest of the token, never the token.
struct BatteryHoldActivityRegistrationStore {
    struct Entry: Codable, Equatable {
        let registrationID: UUID
        let siteID: String
        let holdID: Int
        let tokenDigest: String
    }

    static let key = "pwusage.batteryHoldActivityRegistrations"
    let defaults: UserDefaults

    var entries: [Entry] {
        guard let data = defaults.data(forKey: Self.key),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries
    }

    func entry(_ registrationID: UUID) -> Entry? { entries.first { $0.registrationID == registrationID } }

    func record(_ entry: Entry) {
        save(entries.filter { $0.registrationID != entry.registrationID } + [entry])
    }

    func remove(_ registrationID: UUID) { save(entries.filter { $0.registrationID != registrationID }) }

    func clear() { defaults.removeObject(forKey: Self.key) }

    func save(_ entries: [Entry]) {
        if entries.isEmpty { clear() } else { defaults.set(try? JSONEncoder().encode(entries), forKey: Self.key) }
    }
}
