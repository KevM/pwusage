import SwiftUI

struct RatePlansSheet: View {
    let site: MobileSite
    let actions: TariffTimelineActions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TariffSheet(site: site, actions: actions)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
