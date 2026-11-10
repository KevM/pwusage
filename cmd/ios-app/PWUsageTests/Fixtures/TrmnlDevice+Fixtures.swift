import Foundation
@testable import PWUsage

extension TrmnlComponentConfig {
    static func fixture(showEstimatedBill: Bool = false) -> TrmnlComponentConfig {
        TrmnlComponentConfig(
            showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: false,
            showBatterySoc: false, showEstimatedBill: showEstimatedBill, showLoadTiming: false,
            batterySocMode: "glyph")
    }
}

extension TrmnlDevice {
    static func fixture(
        id: Int = 1, uuid: String = "abcdef12-0000", screenIndex: Int = 0, screenCount: Int = 1,
        showEstimatedBill: Bool = false, connectedAt: Date? = nil
    ) -> TrmnlDevice {
        TrmnlDevice(
            id: id, uuid: uuid, pluginSettingId: id + 4, connectedAt: connectedAt,
            screen: TrmnlScreen(
                name: "Screen \(screenIndex + 1)", index: screenIndex, count: screenCount,
                componentConfig: .fixture(showEstimatedBill: showEstimatedBill)))
    }
}
