import SwiftUI

/// One preview page: the screen, or a placeholder of the same shape while it loads or when it cannot.
struct TrmnlPreviewContent: View {
    let state: TrmnlSettingsModel.Preview

    var body: some View {
        switch state {
        case .loading:
            ProgressView().trmnlPlaceholderFrame()
        case .ready(let document):
            TrmnlPreview(document: document)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
                .accessibilityLabel("Preview of your Trmnl screen")
        case .unavailable:
            Text(TrmnlPresentation.previewUnavailable)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .trmnlPlaceholderFrame()
        }
    }
}

extension View {
    func trmnlPlaceholderFrame() -> some View {
        frame(maxWidth: .infinity, maxHeight: .infinity)
            .aspectRatio(TrmnlPreview.screenSize.width / TrmnlPreview.screenSize.height, contentMode: .fit)
    }
}
