import AppIntents
import Combine
import Foundation

enum BatteryHoldControlIdentity {
    static let kind = "fm.rodeo.pwusage.battery-hold"
    /// A custom glyph rendered blank in device Control Center; see the README,
    /// including its restart requirement, before swapping this out.
    static let symbolName = "bolt.batteryblock"
}

/// Routing only: this intent performs no network requests or reserve writes.
struct OpenBatteryHoldIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Battery Hold"
    static let openAppWhenRun = true

    @Parameter(title: "Site") var target: BatteryHoldControlSite

    init() {}
    init(site: BatteryHoldControlSite) { target = site }

    @MainActor
    func perform() async throws -> some IntentResult {
        BatteryHoldNavigationInbox.shared.send(BatteryHoldLink.url(siteID: target.id))
        return .result()
    }
}

/// A mailbox handles intents arriving before the root view appears, including cold launch.
@MainActor
final class BatteryHoldNavigationInbox: ObservableObject {
    struct Request {
        let id = UUID()
        let url: URL
    }
    static let shared = BatteryHoldNavigationInbox()
    @Published private(set) var request: Request?
    private var consumedID: UUID?

    func send(_ url: URL) { request = Request(url: url) }
    func take() -> URL? {
        guard let request, consumedID != request.id else { return nil }
        consumedID = request.id
        return request.url
    }
}

enum BatteryHoldLink {
    static func url(siteID: String) -> URL {
        var parts = URLComponents()
        parts.scheme = "pwusage"
        parts.host = "battery-hold"
        parts.queryItems = [URLQueryItem(name: "site", value: siteID)]
        return parts.url!
    }

    static func siteID(from url: URL) -> String? {
        guard url.scheme == "pwusage", url.host == "battery-hold",
              url.path.isEmpty, url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = parts.queryItems, items.count == 1,
              items[0].name == "site", let id = items[0].value,
              !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return id
    }
}
