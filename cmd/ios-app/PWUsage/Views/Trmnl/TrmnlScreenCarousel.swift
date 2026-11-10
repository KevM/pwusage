import SwiftUI

/// One page per screen of the device being edited, each previewed as its settings now are. Swiping selects
/// the screen the controls edit. The dots and caption can sit beneath it or be placed elsewhere
/// (`TrmnlScreenPosition`), for layouts that give the preview all the height.
struct TrmnlScreenCarousel: View {
    let editor: TrmnlScreensEditorModel
    var showsPosition = true
    /// Shows a button over the preview that calls this, to open it full screen.
    var onFullScreen: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            TabView(selection: Binding(get: { editor.selectedIndex }, set: { editor.select($0) })) {
                ForEach(Array(editor.screens.enumerated()), id: \.element.id) { index, _ in
                    TrmnlPreviewContent(state: editor.preview(forScreenAt: index)).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .aspectRatio(TrmnlPreview.aspectRatio, contentMode: .fit)
            .overlay(alignment: .topTrailing) {
                if let onFullScreen {
                    Button(action: onFullScreen) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.footnote.weight(.semibold))
                            .padding(8)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .padding(8)
                    .accessibilityLabel("Full screen")
                    .accessibilityIdentifier("trmnl.fullscreen")
                }
            }
            if showsPosition { TrmnlScreenPosition(editor: editor) }
        }
    }
}

/// Where the selected screen is in the rotation: page dots and a caption.
struct TrmnlScreenPosition: View {
    let editor: TrmnlScreensEditorModel
    /// How strong the caption reads; over a dark full-screen preview it needs `.primary` to be legible.
    var captionStyle: HierarchicalShapeStyle = .secondary
    /// A short two-line caption, for a bar too narrow for the full sentence.
    var isCompact = false

    var body: some View {
        VStack(spacing: 8) {
            if editor.screens.count > 1 {
                TrmnlPageDots(count: editor.screens.count, selected: editor.selectedIndex)
            }
            if isCompact {
                Text(TrmnlPresentation.compactPosition(index: editor.selectedIndex, count: editor.screens.count))
                    .font(.footnote)
                    .foregroundStyle(captionStyle)
                if isShowingNow {
                    Text(TrmnlPresentation.onDeviceCompact).font(.caption2).foregroundStyle(captionStyle)
                }
            } else {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(captionStyle)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// Whether the screen shown is the one on the device, which an unsaved reorder or edit no longer is.
    private var isShowingNow: Bool {
        !editor.hasUnsavedChanges && editor.selectedIndex == editor.device.screen.index
    }

    private var caption: String {
        TrmnlPresentation.screenCaption(
            index: editor.selectedIndex, count: editor.screens.count, isShowingNow: isShowingNow)
    }
}
