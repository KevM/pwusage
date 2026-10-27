import SwiftUI

enum SectionTheme {
    case bill
    case loadTiming

    var accent: Color {
        switch self {
        case .bill: .indigo
        case .loadTiming: .teal
        }
    }

    var cardBackground: some View {
        Self.secondaryGroupedBackground
            .overlay(accent.opacity(0.12))
    }

    var screenBackground: some View {
        Self.groupedBackground
            .overlay(accent.opacity(0.05))
    }
}

extension SectionTheme {
    /// Screen background for grouped content. One token so views don't repeat
    /// a platform colour, and another platform's build can supply its own.
    static var groupedBackground: Color {
        #if canImport(UIKit) && !os(tvOS)
            Color(uiColor: .systemGroupedBackground)
        #elseif canImport(AppKit)
            Color(nsColor: .windowBackgroundColor)
        #else
            Color.clear
        #endif
    }

    /// Card background that sits on `groupedBackground`.
    static var secondaryGroupedBackground: Color {
        #if canImport(UIKit) && !os(tvOS)
            Color(uiColor: .secondarySystemGroupedBackground)
        #elseif canImport(AppKit)
            Color(nsColor: .controlBackgroundColor)
        #else
            Color.secondary.opacity(0.1)
        #endif
    }

    /// Widest a section screen's content column grows. Wide enough to fill an
    /// unfolded iPhone Duo; still caps line length on iPad and Mac.
    static let maxContentWidth: CGFloat = 900

    /// Widest a paragraph grows inside that column, so prose keeps a phone-like
    /// line length while charts and bars use the full width.
    static let maxProseWidth: CGFloat = 560
}
