import SwiftUI

/// The editor's preview filling the screen, turned to landscape on a phone. Everything else lives in the
/// black bars around it, so the screen itself is never covered: close, previous and next, and where the
/// screen is in the rotation. Swiping works too.
struct TrmnlFullScreenPreview: View {
    let editor: TrmnlScreensEditorModel
    let onClose: () -> Void
    @State private var cameFromPortrait = false
    /// False while the phone is turning, when the view is laid out at in-between sizes; the black stays up
    /// and the preview fades in once it has settled.
    @State private var isSettled = false
    @State private var isClosing = false

    var body: some View {
        // The outer reader respects the safe area, so it is the one that knows where the island and the home
        // indicator are; a reader that ignores the safe area reports no insets at all.
        GeometryReader { outer in
            content(insets: outer.safeAreaInsets)
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .task { await settle() }
    }

    private func settle() async {
        cameFromPortrait = ScreenOrientation.enterLandscape()
        if cameFromPortrait { try? await Task.sleep(for: ScreenOrientation.turnDuration) }
        withAnimation(.easeIn(duration: 0.25)) { isSettled = true }
    }

    private func content(insets: EdgeInsets) -> some View {
        GeometryReader { proxy in
            let layout = TrmnlFullScreenLayout(
                container: proxy.size,
                safe: .init(
                    leading: insets.leading, top: insets.top, trailing: insets.trailing, bottom: insets.bottom))
            ZStack {
                Color.black
                ZStack {
                    pages.trmnlPlaced(in: layout.preview)
                    closeButton.trmnlPlaced(in: layout.closeButton)
                    step(by: -1, systemImage: "chevron.left", label: "Previous screen")
                        .trmnlPlaced(in: layout.previousButton)
                    step(by: 1, systemImage: "chevron.right", label: "Next screen")
                        .trmnlPlaced(in: layout.nextButton)
                    TrmnlScreenPosition(
                        editor: editor, captionStyle: .primary, arrangement: layout.isLandscape ? .inline : .stacked,
                        inactiveDot: .white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .trmnlPlaced(in: layout.position)
                }
                .opacity(isSettled ? 1 : 0)
            }
        }
        .ignoresSafeArea()
    }

    private var pages: some View {
        TabView(selection: Binding(get: { editor.selectedIndex }, set: { editor.select($0) })) {
            ForEach(Array(editor.screens.enumerated()), id: \.element.id) { index, _ in
                TrmnlPreviewContent(state: editor.preview(forScreenAt: index)).tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
    }

    private var closeButton: some View {
        circleButton(systemImage: "xmark", action: close)
            .accessibilityLabel("Close full screen")
            .accessibilityIdentifier("trmnl.fullscreen.close")
    }

    /// Moves to the previous or next screen; hidden, not removed, where there is none, so the bars do not shift.
    private func step(by offset: Int, systemImage: String, label: String) -> some View {
        let target = editor.selectedIndex + offset
        return circleButton(systemImage: systemImage) {
            withAnimation { editor.select(target) }
        }
        .opacity(editor.screens.indices.contains(target) ? 1 : 0)
        .disabled(!editor.screens.indices.contains(target))
        .accessibilityLabel(label)
    }

    private func circleButton(systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: TrmnlFullScreenLayout.buttonSize, height: TrmnlFullScreenLayout.buttonSize)
                .background(Color.white.opacity(0.18), in: Circle())
        }
    }

    /// Fades the screen out, turns the phone back under the black, and only then lets the cover go, so the
    /// editor behind is never seen mid-turn.
    private func close() {
        guard !isClosing else { return }
        isClosing = true
        Task {
            withAnimation(.easeOut(duration: 0.15)) { isSettled = false }
            await ScreenOrientation.restore(wasPortrait: cameFromPortrait)
            onClose()
        }
    }
}

extension View {
    /// Sizes and centers the view on `rect`, in the coordinate space of the screen.
    func trmnlPlaced(in rect: CGRect) -> some View {
        frame(width: rect.width, height: rect.height).position(x: rect.midX, y: rect.midY)
    }
}
