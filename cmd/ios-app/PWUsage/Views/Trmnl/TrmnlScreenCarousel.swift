import SwiftUI

/// One page per screen of the device being edited, each previewed as its settings now are. Swiping selects
/// the screen the controls edit. The dots and caption can sit beneath it or be placed elsewhere
/// (`TrmnlScreenPosition`), for layouts that give the preview all the height.
struct TrmnlScreenCarousel: View {
    let editor: TrmnlScreensEditorModel
    var showsPosition = true

    var body: some View {
        VStack(spacing: 8) {
            TabView(selection: Binding(get: { editor.selectedIndex }, set: { editor.select($0) })) {
                ForEach(Array(editor.screens.enumerated()), id: \.element.id) { index, _ in
                    TrmnlPreviewContent(state: editor.preview(forScreenAt: index)).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .aspectRatio(TrmnlPreview.aspectRatio, contentMode: .fit)
            if showsPosition { TrmnlScreenPosition(editor: editor) }
        }
    }
}

/// Where the selected screen is in the rotation: page dots and a caption.
struct TrmnlScreenPosition: View {
    let editor: TrmnlScreensEditorModel

    var body: some View {
        VStack(spacing: 8) {
            if editor.screens.count > 1 {
                TrmnlPageDots(count: editor.screens.count, selected: editor.selectedIndex)
            }
            Text(caption).font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    /// Says when the screen shown is the one on the device, which an unsaved reorder or edit no longer is.
    private var caption: String {
        TrmnlPresentation.screenCaption(
            index: editor.selectedIndex, count: editor.screens.count,
            isShowingNow: !editor.hasUnsavedChanges && editor.selectedIndex == editor.device.screen.index)
    }
}
