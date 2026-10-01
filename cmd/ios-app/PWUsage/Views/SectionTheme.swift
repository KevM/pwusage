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
        Color(uiColor: .secondarySystemGroupedBackground)
            .overlay(accent.opacity(0.12))
    }

    var screenBackground: some View {
        Color(uiColor: .systemGroupedBackground)
            .overlay(accent.opacity(0.05))
    }
}
