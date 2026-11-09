import Foundation

/// The server's answer to saving a site's billing day.
struct MobileBillingDay: Codable, Equatable, Sendable {
    /// Days a bill can start on. Months with fewer days start on their last day.
    static let validDays = 1 ... 31

    let billingDay: Int
    let billingDayConfirmed: Bool
}

protocol MobileBillingDayAPI: Sendable {
    func setBillingDay(siteID: String, day: Int) async throws -> MobileBillingDay
}
