import SwiftUI

struct CardContainer<Content: View>: View {
    var title: String?
    var symbol: String?
    var theme: SectionTheme?
    var padding: CGFloat = 17
    var cornerRadius: CGFloat = 20
    var spacing: CGFloat = 13
    var fillsWidth: Bool = true
    var fillsHeight: Bool = false
    var fillAlignment: Alignment = .topLeading
    var showsBorder: Bool = false
    @ViewBuilder let content: Content

    init(
        title: String? = nil,
        symbol: String? = nil,
        theme: SectionTheme? = nil,
        padding: CGFloat = 17,
        cornerRadius: CGFloat = 20,
        spacing: CGFloat = 13,
        fillsWidth: Bool = true,
        fillsHeight: Bool = false,
        fillAlignment: Alignment = .topLeading,
        showsBorder: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.symbol = symbol
        self.theme = theme
        self.padding = padding
        self.cornerRadius = cornerRadius
        self.spacing = spacing
        self.fillsWidth = fillsWidth
        self.fillsHeight = fillsHeight
        self.fillAlignment = fillAlignment
        self.showsBorder = showsBorder
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            if let title, let symbol {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
            }
            content
        }
        .padding(padding)
        .frame(maxWidth: fillsWidth ? .infinity : nil, maxHeight: fillsHeight ? .infinity : nil, alignment: fillAlignment)
        .background {
            Group {
                if let theme {
                    theme.cardBackground
                } else {
                    SectionTheme.secondaryGroupedBackground
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        .overlay {
            if showsBorder {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.045), lineWidth: 1)
            }
        }
    }
}
