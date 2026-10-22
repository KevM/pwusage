import CryptoKit
import Foundation
import WidgetKit

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
    private let widgetStore: TodayEnergySnapshotStore?
    private var widgetSiteID: String?
    private(set) var lastPublishedAt: Date?
    private let now: () -> Date
    private let reloadTimelines: (String) -> Void

    init(fileURL: URL, widgetStore: TodayEnergySnapshotStore? = nil,
         now: @escaping () -> Date = Date.init,
         reloadTimelines: @escaping (String) -> Void = { WidgetCenter.shared.reloadTimelines(ofKind: $0) }) {
        self.now = now
        self.reloadTimelines = reloadTimelines
        self.widgetStore = widgetStore
        self.fileURL = fileURL
        snapshot = (try? Data(contentsOf: fileURL))
            .flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } ?? Snapshot()
    }

    static func persistent(apiOrigin: URL) -> DashboardCache {
        let key = SHA256.hash(data: Data(apiOrigin.absoluteString.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let directory = URL.cachesDirectory.appendingPathComponent("pwusage", isDirectory: true)
        return DashboardCache(fileURL: directory.appendingPathComponent("dashboard-\(key).json"), widgetStore: .shared())
    }

    func storeSites(_ sites: [MobileSite]) {
        snapshot.sites = sites
        let authorizedIDs = Set(sites.map(\.id))
        snapshot.live = snapshot.live.filter { authorizedIDs.contains($0.key) }
        snapshot.bill = snapshot.bill.filter { authorizedIDs.contains($0.key) }
        let selectedSiteWasRevoked = widgetSiteID.map { !authorizedIDs.contains($0) } ?? false
        // The App Group file can outlive an evicted private cache and its in-memory selection.
        if sites.isEmpty || selectedSiteWasRevoked { selectWidgetSite(nil) }
        persist()
    }

    func selectWidgetSite(_ siteID: String?) {
        widgetSiteID = siteID
        publishWidget()
    }

    private func publishWidget() {
        guard let widgetStore else { return }
        let previous = widgetStore.load()
        var removedSnapshot = false
        if let siteID = widgetSiteID, let reading = snapshot.live[siteID] {
            let response = reading.response
            let site = response.site
            let energy = TodayEnergy(localDate: site.localDate, homeKwh: response.today.homeKwh,
                                     solarKwh: response.today.solarKwh, gridNetKwh: response.today.gridNetKwh,
                                     batteryNetKwh: response.today.batteryNetKwh, activeTariff: response.activeTariff,
                                     todayComplete: response.todayComplete, energyDataThrough: response.sources.energyDataThrough)
            let value = TodayEnergySnapshot(siteID: siteID, siteName: site.name, timezone: site.timezone,
                                            fetchedAt: reading.savedAt, energy: energy,
                                            todayCost: response.todayCost,
                                            batteryStateOfCharge: response.stateOfCharge,
                                            batteryStateOfChargeAt: response.sources.stateOfChargeAt)
            guard value != previous else { return }
            do { try widgetStore.save(value) } catch {
                widgetStore.clear()
                removedSnapshot = true
            }
        } else {
            guard previous != nil else { return }
            widgetStore.clear()
            removedSnapshot = true
        }
        let date = now()
        // Removal invalidates already-rendered account/site data immediately.
        // Only routine snapshot updates consume the throttled refresh budget.
        let reloadIsDue = lastPublishedAt.map { date.timeIntervalSince($0) >= 15 * 60 } ?? true
        guard removedSnapshot || reloadIsDue else { return }
        lastPublishedAt = date
        reloadTimelines(TodayEnergySnapshot.widgetKind)
        reloadTimelines(TodayEnergySnapshot.metricWidgetKind)
    }

    func storeLive(_ response: MobileLiveResponse, at date: Date) {
        guard snapshot.sites.contains(where: { $0.id == response.site.id }) else { return }
        snapshot.live[response.site.id] = Reading(response: response, savedAt: date)
        if response.site.id == widgetSiteID { publishWidget() }
        persist()
    }

    func storeBill(_ response: MobileBillResponse, at date: Date) {
        guard snapshot.sites.contains(where: { $0.id == response.site.id }) else { return }
        snapshot.bill[response.site.id] = Reading(response: response, savedAt: date)
        persist()
    }

    func clear() {
        snapshot = Snapshot()
        selectWidgetSite(nil)
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
