import AppIntents
import Foundation

struct BatteryHoldControlSite: AppEntity, Codable, Equatable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Site"
    static let defaultQuery = BatteryHoldControlSiteQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct BatteryHoldControlSiteQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [BatteryHoldControlSite] {
        let sites = BatteryHoldControlSiteStore.shared()?.load() ?? []
        // Retain saved identifiers after logout/removal so a tap reaches the app's
        // sign-in/access checks instead of silently substituting another site.
        return identifiers.map { id in
            sites.first(where: { $0.id == id }) ?? BatteryHoldControlSite(id: id, name: "Saved site")
        }
    }
    func suggestedEntities() async throws -> [BatteryHoldControlSite] {
        BatteryHoldControlSiteStore.shared()?.load() ?? []
    }
}

/// Noncredential picker metadata. Only the app writes; no extension networking.
struct BatteryHoldControlSiteStore {
    let fileURL: URL
    static func shared() -> Self? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PWUSAGE_APP_GROUP") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return Self(fileURL: directory.appendingPathComponent("battery-hold-control-sites.json"))
    }
    func load() -> [BatteryHoldControlSite] {
        guard let data = try? Data(contentsOf: fileURL),
              let sites = try? JSONDecoder().decode([BatteryHoldControlSite].self, from: data) else { return [] }
        return sites
    }
    func save(_ sites: [BatteryHoldControlSite]) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(sites).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { clear() }
    }
    func clear() {
        try? Data("[]".utf8).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try? FileManager.default.removeItem(at: fileURL)
    }
}
