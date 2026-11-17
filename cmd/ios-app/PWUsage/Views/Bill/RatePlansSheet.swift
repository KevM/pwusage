import SwiftUI

struct RatePlansSheet: View {
    let site: MobileSite
    let actions: TariffTimelineActions
    var startsAddingPlan = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TariffSheet(site: site, actions: actions, startsAddingPlan: startsAddingPlan)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
