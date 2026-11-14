import Foundation

enum BillPricingMode: String, Sendable {
    case server
    case shadow
    case local

    static let defaultMode: Self = .shadow

    init(configuration: AppConfiguration, defaults: UserDefaults = .standard) {
        let raw = configuration.billPricingModeRaw
            ?? defaults.string(forKey: AppConfiguration.billPricingModeKey)
        self = raw.flatMap(Self.init(rawValue:)) ?? .defaultMode
    }

    static func current(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> Self {
        let raw = environment[AppConfiguration.billPricingModeKey]
            ?? defaults.string(forKey: AppConfiguration.billPricingModeKey)
            ?? bundle.object(forInfoDictionaryKey: AppConfiguration.billPricingModeKey) as? String
        return raw.flatMap(Self.init(rawValue:)) ?? .defaultMode
    }
}
