import Foundation

enum BillPricingMode: String, Sendable {
    case server
    case shadow
    case local

    static let defaultMode: Self = .local

    init(configuration: AppConfiguration, defaults: UserDefaults = .standard) {
        let raw = configuration.billPricingModeRaw
            ?? defaults.string(forKey: AppConfiguration.billPricingModeKey)
        self = raw.flatMap(Self.init(rawValue:)) ?? .defaultMode
    }
}
