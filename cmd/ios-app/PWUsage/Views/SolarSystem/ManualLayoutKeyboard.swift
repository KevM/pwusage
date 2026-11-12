import SwiftUI
#if canImport(UIKit)
    import UIKit
#endif

/// Keyboard handling the layout editor needs beyond what FocusState gives it.
enum ManualLayoutKeyboard {
    /// Dismisses the keyboard whichever field has it. A FocusState only knows the fields it was
    /// attached to, so clearing it leaves the name fields' keyboard up.
    @MainActor static func dismiss() {
        #if canImport(UIKit)
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}

extension View {
    /// Selects a number field's whole value when it gains focus, so typing replaces it. A tap on a
    /// right-aligned number puts the caret before the digits, and typing then prepends to the old
    /// value (a 10 became 2810 and the layout turned invalid).
    @ViewBuilder func selectsNumbersOnFocus() -> some View {
        #if canImport(UIKit)
            onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
                guard let field = note.object as? UITextField, field.keyboardType == .decimalPad else { return }
                // After UIKit has placed the caret from the tap, which would undo the selection.
                Task { @MainActor in field.selectAll(nil) }
            }
        #else
            self
        #endif
    }
}
