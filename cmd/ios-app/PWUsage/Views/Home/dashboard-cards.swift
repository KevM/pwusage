import SwiftUI

struct StatusCard<Content: View>: View {
    var theme: SectionTheme?
    /// Where the content sits when the card is stretched to fill its row.
    var fillAlignment: Alignment = .topLeading
    @ViewBuilder let content: Content
    @Environment(\.dashboardCardsFillHeight) private var fillsHeight

    var body: some View {
        CardContainer(
            theme: theme,
            padding: 16,
            cornerRadius: 22,
            spacing: 0,
            fillsHeight: fillsHeight,
            fillAlignment: fillAlignment,
            showsBorder: true
        ) {
            content
        }
    }
}
