import Foundation

/// Copy and links for the Trmnl screen in Settings. Voice follows `docs/voice-and-terms.md`.
enum TrmnlPresentation {
    static let title = "Trmnl"
    static let previewHeader = "Your screen"
    static let previewUnavailable = "The preview is not available right now."
    static let devicesHeader = "Devices"
    static let devicesFailure = "Your Trmnl devices could not be loaded."
    static let emptyTitle = "Show your energy on a Trmnl"
    static let emptyMessage = "Add the pwusage plugin on trmnl.com. Your device appears here once it connects."
    static let addTitle = "Add Trmnl"
    static let addAnotherTitle = "Add another device"
    static let savedTitle = "Saved"
    static let retryTitle = "Try Again"
    static let saveFailure = "Your changes could not be saved. Try again, or keep editing to retry."
    static let screensLoadFailure = "This device's screens could not be loaded."
    static let addScreenTitle = "Add screen"
    static let deleteScreenTitle = "Delete screen"
    static let moveEarlierTitle = "Move earlier"
    static let moveLaterTitle = "Move later"
    static let liveStatsHeader = "Live stats"
    static let chartsHeader = "Charts and tables"
    static let screenHeader = "Screen"
    static let openTitle = "Open in Trmnl"

    static func screenCaption(index: Int, count: Int, isShowingNow: Bool) -> String {
        let position = "Screen \(index + 1) of \(count)"
        return isShowingNow ? "\(position) · On the device now" : position
    }

    /// The position in a narrow bar: "1 of 3", and a second short line when it is the screen on the device.
    static func compactPosition(index: Int, count: Int) -> String {
        "\(index + 1) of \(count)"
    }

    static let onDeviceCompact = "On device"

    static func deleteConfirmation(screenName: String) -> String {
        "Delete \(screenName)? This cannot be undone."
    }

    static func addButtonTitle(deviceCount: Int) -> String {
        deviceCount == 0 ? addTitle : addAnotherTitle
    }

    static func deviceCountLabel(_ count: Int) -> String {
        count == 1 ? "1 device" : "\(count) devices"
    }

    static func name(for device: TrmnlDevice) -> String {
        "Device \(device.uuid.prefix(8))"
    }

    /// Under a preview: which device it is, and which of its screens when it rotates through several.
    static func caption(for device: TrmnlDevice) -> String {
        let screen = device.screen
        guard screen.count > 1 else { return name(for: device) }
        return "\(name(for: device)) · Screen \(screen.index + 1) of \(screen.count)"
    }

    /// The day the device connected, read in UTC like the web app so both name the same day.
    static func connectedLabel(for device: TrmnlDevice, locale: Locale = .current) -> String? {
        guard let date = device.connectedAt else { return nil }
        let style = Date.FormatStyle(locale: locale, timeZone: .gmt).month(.abbreviated).day().year()
        return "Connected \(date.formatted(style))"
    }

    static var addURL: URL {
        trmnlURL(path: "/plugin_settings/new", query: [URLQueryItem(name: "keyname", value: "powerwall_energy_usage")])
    }

    static func openURL(for device: TrmnlDevice) -> URL {
        trmnlURL(path: "/plugin_settings/\(device.pluginSettingId)/edit")
    }

    private static func trmnlURL(path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "trmnl.com"
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { preconditionFailure("The Trmnl URL is built from valid parts") }
        return url
    }
}
