import CryptoKit
import Foundation

extension BillPricing {
    /// Cache identity for the timeline fields that affect local billing and savings.
    public static func timelineFingerprint(_ timeline: SiteTariffsTimelineResponse) -> String {
        struct FingerprintPayload: Encodable {
            let periods: [TariffPeriodDTO]
            let referencePeriods: [TariffPeriodDTO]
            let battery: SiteBatteryDTO?
            let holidayDates: [String]
            let systemCosts: SystemCostsDTO?
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = FingerprintPayload(
            periods: timeline.periods,
            referencePeriods: timeline.referencePeriods,
            battery: timeline.battery,
            holidayDates: timeline.holidayDates ?? [],
            systemCosts: timeline.systemCosts
        )
        let data = (try? encoder.encode(payload)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
