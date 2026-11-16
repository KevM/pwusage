import SwiftUI

/// The row a picker is saving, then the row it saved, so the owner sees what they tapped before the
/// sheet closes. Keyed by the row's identity (a utility name or a plan label).
enum PickerChoice: Equatable {
    case saving(String)
    case saved(String)

    /// How long a saved row stays checked before the picker closes.
    static let defaultConfirmationHold: Duration = .milliseconds(600)

    var id: String {
        switch self {
        case .saving(let id), .saved(let id): id
        }
    }
}

/// The trailing mark on a picker row: a spinner while it saves, a check once saved.
struct PickerChoiceMark: View {
    let choice: PickerChoice?
    let id: String

    var body: some View {
        switch choice {
        case .saving(id):
            ProgressView()
        case .saved(id):
            Image(systemName: "checkmark")
                .fontWeight(.semibold)
                .foregroundStyle(Color.emphasis)
                .accessibilityHidden(true)
        default:
            EmptyView()
        }
    }
}
