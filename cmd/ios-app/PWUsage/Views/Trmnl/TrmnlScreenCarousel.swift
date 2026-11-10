import SwiftUI

/// One page per screen of the device being edited, each previewed as its settings now are. Swiping selects
/// the screen the controls edit.
struct TrmnlScreenCarousel: View {
    let editor: TrmnlScreensEditorModel

    var body: some View {
        VStack(spacing: 8) {
            TabView(selection: Binding(get: { editor.selectedIndex }, set: { editor.select($0) })) {
                ForEach(Array(editor.screens.enumerated()), id: \.element.id) { index, _ in
                    TrmnlPreviewContent(state: editor.preview(forScreenAt: index)).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .aspectRatio(TrmnlPreview.screenSize.width / TrmnlPreview.screenSize.height, contentMode: .fit)
            if editor.screens.count > 1 {
                TrmnlPageDots(count: editor.screens.count, selected: editor.selectedIndex)
            }
            Text(caption).font(.footnote).foregroundStyle(.secondary)
        }
    }

    /// Says when the screen shown is the one on the device, which an unsaved reorder or edit no longer is.
    private var caption: String {
        TrmnlPresentation.screenCaption(
            index: editor.selectedIndex, count: editor.screens.count,
            isShowingNow: !editor.hasUnsavedChanges && editor.selectedIndex == editor.device.screen.index)
    }
}
