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

    init(fileURL: URL, widgetStore: TodayEnergySnapshotStore? = nil) {
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
        if let widgetSiteID, !authorizedIDs.contains(widgetSiteID) { selectWidgetSite(nil) }
        persist()
    }

    func selectWidgetSite(_ siteID: String?) {
        widgetSiteID = siteID
        publishWidget()
    }

    private func publishWidget() {
        guard let widgetStore else { return }
        if let siteID = widgetSiteID, let reading = snapshot.live[siteID] {
            let response = reading.response
            let site = response.site
            let energy = TodayEnergy(localDate: site.localDate, homeKwh: response.today.homeKwh,
                                     solarKwh: response.today.solarKwh, gridNetKwh: response.today.gridNetKwh,
                                     batteryNetKwh: response.today.batteryNetKwh, activeTariff: response.activeTariff,
                                     todayComplete: response.todayComplete, energyDataThrough: response.sources.energyDataThrough)
            let value = TodayEnergySnapshot(siteID: siteID, siteName: site.name, timezone: site.timezone,
                                            fetchedAt: reading.savedAt, energy: energy,
                                            batteryStateOfCharge: response.stateOfCharge,
                                            batteryStateOfChargeAt: response.sources.stateOfChargeAt)
            do { try widgetStore.save(value) }
            catch { widgetStore.clear() }
        } else {
            widgetStore.clear()
        }
        WidgetCenter.shared.reloadTimelines(ofKind: TodayEnergySnapshot.widgetKind)
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
