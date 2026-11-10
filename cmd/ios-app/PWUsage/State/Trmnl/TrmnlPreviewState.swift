/// A Trmnl screen's preview: loading, the document to draw, or not available.
enum TrmnlPreviewState: Equatable {
    case loading
    case ready(document: String)
    case unavailable
}
