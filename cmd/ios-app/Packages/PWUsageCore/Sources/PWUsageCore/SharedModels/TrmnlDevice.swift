import Foundation

/// Which parts of the site's data a Trmnl screen shows. Sent back unchanged to preview the screen.
public struct TrmnlComponentConfig: Codable, Hashable, Sendable {
    public var showLiveGrid: Bool
    public var showLiveSolar: Bool
    public var showLiveBattery: Bool
    public var showEnergyChart: Bool
    public var showBatterySoc: Bool
    public var showEstimatedBill: Bool
    public var showLoadTiming: Bool
    /// "glyph" or "chart".
    public var batterySocMode: String

    /// What a new screen starts as, matching the web editor.
    public static let newScreen = TrmnlComponentConfig(
        showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: true,
        showBatterySoc: true, showEstimatedBill: false, showLoadTiming: false, batterySocMode: "chart")

    public init(
        showLiveGrid: Bool, showLiveSolar: Bool, showLiveBattery: Bool, showEnergyChart: Bool,
        showBatterySoc: Bool, showEstimatedBill: Bool, showLoadTiming: Bool, batterySocMode: String
    ) {
        self.showLiveGrid = showLiveGrid
        self.showLiveSolar = showLiveSolar
        self.showLiveBattery = showLiveBattery
        self.showEnergyChart = showEnergyChart
        self.showBatterySoc = showBatterySoc
        self.showEstimatedBill = showEstimatedBill
        self.showLoadTiming = showLoadTiming
        self.batterySocMode = batterySocMode
    }
}

/// The screen a device last fetched, out of the screens it rotates through.
public struct TrmnlScreen: Codable, Equatable, Sendable {
    public let name: String
    /// Zero-based position in the rotation.
    public let index: Int
    public let count: Int
    public let componentConfig: TrmnlComponentConfig

    public init(name: String, index: Int, count: Int, componentConfig: TrmnlComponentConfig) {
        self.name = name
        self.index = index
        self.count = count
        self.componentConfig = componentConfig
    }
}

/// A Trmnl device that finished connecting to a site.
public struct TrmnlDevice: Codable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let uuid: String
    /// The device's plugin on trmnl.com, which `Open in Trmnl` links to.
    public let pluginSettingId: Int
    /// Nil when the server could not date the install.
    public let connectedAt: Date?
    public let screen: TrmnlScreen

    public init(id: Int, uuid: String, pluginSettingId: Int, connectedAt: Date?, screen: TrmnlScreen) {
        self.id = id
        self.uuid = uuid
        self.pluginSettingId = pluginSettingId
        self.connectedAt = connectedAt
        self.screen = screen
    }
}

public struct TrmnlDevicesResponse: Decodable, Equatable, Sendable {
    public let devices: [TrmnlDevice]

    public init(devices: [TrmnlDevice]) {
        self.devices = devices
    }
}

/// The site preview answer. `document` is a self-contained page the app renders as it is; a server that
/// predates it leaves it out.
public struct TrmnlPreviewResponse: Decodable, Equatable, Sendable {
    public let document: String?

    public init(document: String?) {
        self.document = document
    }
}

/// One of the screens a device rotates through, as the web app stores it.
public struct TrmnlManagedScreen: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    /// Always "Screen 1", "Screen 2" and so on by position.
    public var name: String
    public var componentConfig: TrmnlComponentConfig

    /// The most screens a device holds.
    public static let maxScreens = 3

    public init(id: String, name: String, componentConfig: TrmnlComponentConfig) {
        self.id = id
        self.name = name
        self.componentConfig = componentConfig
    }
}

/// The screens page's answer for a device.
public struct TrmnlManagedScreensResponse: Decodable, Equatable, Sendable {
    public let screens: [TrmnlManagedScreen]

    private enum CodingKeys: String, CodingKey { case screens = "component_screens" }

    public init(screens: [TrmnlManagedScreen]) {
        self.screens = screens
    }
}
