#if DEBUG
import Foundation

/// Shared by Xcode previews and visual checks. No App Group reads or networking.
enum TodayEnergyPreviewFixtures {
    static let date = Date(timeIntervalSince1970: 1_792_008_000)
    static let timezone = "America/Chicago"

    static func snapshot(homeKwh: Double = 18.4, solarKwh: Double = 22.6,
                         gridNetKwh: Double = -2.4, batteryNetKwh: Double = -1.8,
                         stateOfCharge: Double? = 78, sourceAge: TimeInterval = 5 * 60,
                         chargeAge: TimeInterval = 5 * 60, complete: Bool = true,
                         siteName: String = "Home") -> TodayEnergySnapshot {
        TodayEnergySnapshot(siteID: "preview-home", siteName: siteName, timezone: timezone, fetchedAt: date,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(date, timezone: timezone),
                                homeKwh: homeKwh, solarKwh: solarKwh, gridNetKwh: gridNetKwh,
                                batteryNetKwh: batteryNetKwh, activeTariff: "Off peak", todayComplete: complete,
                                energyDataThrough: date.addingTimeInterval(-sourceAge)),
            batteryStateOfCharge: stateOfCharge, batteryStateOfChargeAt: date.addingTimeInterval(-chargeAge))
    }
}
#endif
