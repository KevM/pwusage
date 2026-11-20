import SwiftUI

/// How an action button looks and behaves while its work runs. Busy is not disabled: `.disabled`
/// greys the button, which hides its spinner and reads as stuck rather than working.
struct BusyButtonRule: Equatable {
    let isEnabled: Bool
    let isBusy: Bool

    /// Greyed only when the action can't run yet; a running action keeps its colour.
    var isGreyedOut: Bool { !isEnabled && !isBusy }
    /// Taps and VoiceOver activations run the action only when it is enabled and idle.
    var runsAction: Bool { isEnabled && !isBusy }
}

/// The app's prominent action button. While `isBusy` it keeps its colour, swaps `title` for a
/// spinner and `busyTitle`, and ignores taps until the work finishes. Callers set the font and
/// control size; `isEnabled` is only for "can't run yet".
struct ProminentActionButton: View {
    let title: String
    let busyTitle: String
    let isBusy: Bool
    var isEnabled = true
    var fillsWidth = true
    let action: () -> Void

    private var rule: BusyButtonRule { BusyButtonRule(isEnabled: isEnabled, isBusy: isBusy) }

    var body: some View {
        Button {
            if rule.runsAction { action() }
        } label: {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView()
                        .tint(Color.onEmphasis)
                    Text(busyTitle)
                } else {
                    Text(title)
                }
            }
            .frame(maxWidth: fillsWidth ? .infinity : nil)
        }
        .emphasisProminentButton()
        .disabled(rule.isGreyedOut)
        .allowsHitTesting(!isBusy)
    }
}

/// A toolbar confirmation button (Save) that turns into a spinner while its work runs, like the
/// rate plan editor's. VoiceOver reads `busyTitle` in its place.
struct ToolbarBusyButton: View {
    let title: String
    let busyTitle: String
    let isBusy: Bool
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        if isBusy {
            ProgressView()
                .accessibilityLabel(busyTitle)
        } else {
            Button(title, action: action)
                .disabled(!isEnabled)
        }
    }
}

/// A list row's label with a trailing spinner while that row's action runs.
struct BusyRowLabel<Content: View>: View {
    let isBusy: Bool
    @ViewBuilder let content: Content

    var body: some View {
        HStack {
            content
            Spacer(minLength: 8)
            if isBusy { ProgressView() }
        }
    }
}
