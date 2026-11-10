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
    static let screensTitle = "Screens"
    static let openTitle = "Open in Trmnl"

    static func addButtonTitle(deviceCount: Int) -> String {
        deviceCount == 0 ? addTitle : addAnotherTitle
    }

    static func name(for device: TrmnlDevice) -> String {
        "Device \(device.uuid.prefix(8))"
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

    /// The web app's screens page for the device, which the sheet shows.
    static func screensURL(origin: URL, device: TrmnlDevice) -> URL {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            preconditionFailure("The API origin is a valid URL")
        }
        components.path = "/trmnl/manage"
        components.queryItems = [URLQueryItem(name: "uuid", value: device.uuid)]
        guard let url = components.url else { preconditionFailure("The screens URL is built from valid parts") }
        return url
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
