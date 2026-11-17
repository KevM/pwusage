import Foundation

extension RatePlanHistoryFlow {
    /// The spans review lists, newest first, with their index in `spans` for Change. A span left with
    /// no days (it starts after it ends) is left out, as `periods()` leaves it out of the save.
    var reviewSpans: [(index: Int, span: Span)] {
        spans.enumerated()
            .filter { _, span in span.endDate.map { span.from <= $0 } ?? true }
            .map { (index: $0.offset, span: $0.element) }
    }

    /// Review's Change: steps back until the span at `index` (newest first) is gone, which lands on the
    /// answer that created it. An index past the spans changes nothing.
    mutating func reopenSpan(at index: Int) {
        while spans.count > index {
            let before = self
            back()
            if self == before { return }
        }
    }
}
