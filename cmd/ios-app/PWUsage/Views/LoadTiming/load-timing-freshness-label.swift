import SwiftUI

/// How stale the energy observations are, in words.
///
/// This is one of only two things on the load timing screen that move with the
/// clock, so it owns a minute timeline of its own. Using the timeline's own date
/// keeps the label and the tick that redraws it on the same clock instead of a
/// second one.
struct LoadTimingFreshnessLabel: View {
    let isUnavailable: Bool
    let energyDataThrough: Date?
    /// Whether the label carries a `"Source freshness: …"` accessibility prefix.
    /// This preserves what each call site announced before the label was
    /// extracted: the recommendation card's caption set that label, and the
    /// metadata footer — already combined with its neighbours into one
    /// accessibility element — did not. It is an announcement choice, not an
    /// attempt to influence how `.combine` groups a nested timeline.
    var announcesFreshness = true

    var body: some View {
        TimelineView(.everyMinute) { context in
            let status = LoadTimingPresentation.sourceStatus(
                isUnavailable: isUnavailable,
                energyDataThrough: energyDataThrough,
                now: context.date
            )
            Text(status)
                .font(.caption)
                .foregroundStyle(isUnavailable ? .orange : .secondary)
                .modifier(LoadTimingFreshnessAnnouncement(announces: announcesFreshness, status: status))
        }
    }
}

/// The recommendation card's caption announced what the label meant and wrapped
/// freely; the metadata footer, already combined into a single accessibility
/// element, announced only the status text and was left to wrap like its
/// neighbours. Restoring each call site exactly means the announcement and that
/// wrapping have to travel together, so they are decided in one place.
struct LoadTimingFreshnessAnnouncement: ViewModifier {
    let announces: Bool
    let status: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if announces {
            content
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Source freshness: \(status)")
        } else {
            content
        }
    }
}

struct LoadTimingCard<Content: View>: View {
    var title: String? = nil
    var symbol: String? = nil
    @ViewBuilder let content: Content

    init(title: String? = nil, symbol: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.content = content()
    }

    var body: some View {
        CardContainer(title: title, symbol: symbol) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
