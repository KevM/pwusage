import Foundation

extension RatePlanHistoryFlow {
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
