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
    enum Arrangement {
        /// Dots above the caption.
        case stacked
        /// Dots beside the caption, on one line, for a strip under the preview.
        case inline
    }

    let editor: TrmnlScreensEditorModel
    /// How strong the caption reads; over a dark full-screen preview it needs `.primary` to be legible.
    var captionStyle: HierarchicalShapeStyle = .secondary
    var arrangement = Arrangement.stacked
    var inactiveDot: Color = .secondary.opacity(0.5)

    var body: some View {
        Group {
            switch arrangement {
            case .stacked:
                VStack(spacing: 8) {
                    dots
                    captionText
                }
            case .inline:
                HStack(spacing: 12) {
                    dots
                    captionText.lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var dots: some View {
        if editor.screens.count > 1 {
            TrmnlPageDots(count: editor.screens.count, selected: editor.selectedIndex, inactive: inactiveDot)
        }
    }

    private var captionText: some View {
        Text(caption)
            .font(.footnote)
            .foregroundStyle(captionStyle)
            .fixedSize(horizontal: false, vertical: true)
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
