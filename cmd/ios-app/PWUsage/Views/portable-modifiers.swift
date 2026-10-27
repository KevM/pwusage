import SwiftUI

/// iOS-only modifiers wrapped so shared views compile unchanged on a platform
/// that lacks them, where each is the identity.
extension View {
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
            navigationBarTitleDisplayMode(.inline)
        #else
            self
        #endif
    }

    func pointerHoverEffect() -> some View {
        #if os(iOS)
            hoverEffect()
        #else
            self
        #endif
    }
}
