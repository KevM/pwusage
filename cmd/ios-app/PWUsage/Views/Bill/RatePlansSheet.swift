import PWUsageCore
import SwiftUI

struct RatePlansSheet: View {
    let site: MobileSite
    let actions: TariffTimelineActions
    var startsAddingPlan = false
    var scrollTarget: RatePlansScrollTarget?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TariffSheet(site: site, actions: actions, startsAddingPlan: startsAddingPlan, scrollTarget: scrollTarget)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
