import SwiftUI

extension Color {
    /// Cerulean: the app's one emphasis color, and its accent color. See the iOS guide.
    static let emphasis = Color("Emphasis")
    /// Text and symbols on an `emphasis` fill. White in light mode; dark mode's brighter fill needs a dark label.
    static let onEmphasis = Color("OnEmphasis")
}

extension View {
    /// The primary action style, with a label that stays readable on the emphasis fill in dark mode.
    func emphasisProminentButton() -> some View {
        buttonStyle(.borderedProminent)
            .tint(.emphasis)
            .foregroundStyle(Color.onEmphasis)
    }
}
