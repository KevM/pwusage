import Foundation

public struct SolarForecastSiteScope: Hashable, Codable, Sendable {
    public let accountScopeID: String
    public let siteID: String

    public init(accountScopeID: String, siteID: String) {
        self.accountScopeID = accountScopeID
        self.siteID = siteID
    }
}
