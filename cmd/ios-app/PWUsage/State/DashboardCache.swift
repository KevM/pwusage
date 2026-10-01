import CryptoKit
import Foundation

/// A disposable launch snapshot, never evidence of a valid authenticated session.
@MainActor
final class DashboardCache {
    struct Reading<Response: Codable>: Codable {
        let response: Response
        let savedAt: Date
    }

    struct Snapshot: Codable {
        var sites: [MobileSite] = []
        var live: [String: Reading<MobileLiveResponse>] = [:]
        var bill: [String: Reading<MobileBillResponse>] = [:]
    }

    private(set) var snapshot: Snapshot
    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        snapshot = (try? Data(contentsOf: fileURL))
            .flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } ?? Snapshot()
    }

    static func persistent(apiOrigin: URL) -> DashboardCache {
        let key = SHA256.hash(data: Data(apiOrigin.absoluteString.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let directory = URL.cachesDirectory.appendingPathComponent("pwusage", isDirectory: true)
        return DashboardCache(fileURL: directory.appendingPathComponent("dashboard-\(key).json"))
    }

    func storeSites(_ sites: [MobileSite]) {
        snapshot.sites = sites
        let authorizedIDs = Set(sites.map(\.id))
        snapshot.live = snapshot.live.filter { authorizedIDs.contains($0.key) }
        snapshot.bill = snapshot.bill.filter { authorizedIDs.contains($0.key) }
        persist()
    }

    func storeLive(_ response: MobileLiveResponse, at date: Date) {
        guard snapshot.sites.contains(where: { $0.id == response.site.id }) else { return }
        snapshot.live[response.site.id] = Reading(response: response, savedAt: date)
        persist()
    }

    func storeBill(_ response: MobileBillResponse, at date: Date) {
        guard snapshot.sites.contains(where: { $0.id == response.site.id }) else { return }
        snapshot.bill[response.site.id] = Reading(response: response, savedAt: date)
        persist()
    }

    func clear() {
        snapshot = Snapshot()
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func persist() {
        // A cache failure must never turn a successful network refresh into an error.
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch { /* iOS may evict or temporarily make the cache unavailable. */ }
    }
}
