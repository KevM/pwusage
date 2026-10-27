#if DEBUG
    import SwiftUI

    struct BatteryHoldPreview: View {
        @StateObject private var coordinator: DashboardCoordinator
        private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

        init(mode: BatteryHoldPreviewAPI.Mode) {
            _coordinator = StateObject(wrappedValue: DashboardCoordinator(siteID: "preview-home", api: BatteryHoldPreviewAPI(mode: mode), timerInterval: nil))
        }

        var body: some View {
            BatteryHoldSheet(coordinator: coordinator, site: site)
                .task {
                    await coordinator.refreshAll(trigger: .userGesture)
                    await coordinator.refreshBatteryHold()
                }
        }
    }

    #Preview("Battery Hold · Idle") { BatteryHoldPreview(mode: .idle) }
    #Preview("Battery Hold · Reserve Choice") { BatteryHoldPreview(mode: .ambiguous) }
    #Preview("Battery Hold · Active Timer") { BatteryHoldPreview(mode: .active) }
    #Preview("Battery Hold · Reserve Changed") { BatteryHoldPreview(mode: .notice) }
    #Preview("Battery Hold · Accessibility Text") {
        BatteryHoldPreview(mode: .ambiguous).environment(\.dynamicTypeSize, .accessibility3)
    }
#endif
