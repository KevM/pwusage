import Foundation
import PWUsageCore

/// The app owns selection; the widget reads this seed and keeps its refresh cache separately.
struct TodayEnergySnapshotStore: Sendable {
    let fileURL: URL

    static func shared() -> Self? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PWUSAGE_APP_GROUP") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            return nil
        }
        return Self(fileURL: directory.appendingPathComponent("today-energy-v2.json"))
    }

    func load() -> TodayEnergySnapshot? {
        guard let data = try? Data(contentsOf: fileURL),
              let value = try? JSONDecoder().decode(TodayEnergySnapshot.self, from: data),
              value.version == 2 else { return nil }
        return value
    }

    func save(_ value: TodayEnergySnapshot) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try JSONEncoder().encode(value)
            .write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    var refreshFileURL: URL {
        fileURL.deletingLastPathComponent().appendingPathComponent("today-energy-widget-refresh.json")
    }

    func clear() {
        try? FileManager.default.removeItem(at: refreshFileURL)
        // Write a tombstone atomically before removal, so a failed removal cannot expose old data.
        try? Data("{}".utf8).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try? FileManager.default.removeItem(at: fileURL)
    }
}
