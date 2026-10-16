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
}
