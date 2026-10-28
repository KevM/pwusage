import Foundation
@testable import PWUsage
import Testing

struct EnergyWeatherChartLayoutTests {
    private typealias Layout = SwitchLabelLayout

    @Test func roomyChartShowsBothHalvesOfEveryLabel() {
        let placed = Layout.place(xs: [100, 300, 500], beforeWidths: [70, 70, 70], afterWidths: [70, 70, 70], chartWidth: 700)
        #expect(placed == [.both, .both, .both])
    }

    @Test func aSwitchNearAnEdgeKeepsOnlyTheHalfThatFitsBesideIt() {
        // At 10 pt there's no room for "← Off-Peak" to its left; at 690 none for "On-Peak →" to its right.
        #expect(Layout.place(xs: [10], beforeWidths: [70], afterWidths: [70], chartWidth: 700) == [.after])
        #expect(Layout.place(xs: [690], beforeWidths: [70], afterWidths: [70], chartWidth: 700) == [.before])
    }

    @Test func crowdedSwitchesDropHalvesRatherThanOverlap() {
        // Portrait, 250 pt: the first keeps only "On-Peak →" (13–73); the second's left half would
        // touch it, so it keeps its right half (131–191); the third has room for neither.
        let placed = Layout.place(xs: [10, 128, 203], beforeWidths: [60, 60, 60], afterWidths: [60, 60, 60], chartWidth: 250)
        #expect(placed == [.after, .after, .hidden])
    }

    @Test func shownHalvesTouchTheirLineAndNeverOverlapOrLeaveTheChart() {
        let xs: [CGFloat] = [5, 40, 90, 120, 180, 240]
        let before = [CGFloat](repeating: 62, count: xs.count), after = [CGFloat](repeating: 55, count: xs.count)
        let placed = Layout.place(xs: xs, beforeWidths: before, afterWidths: after, chartWidth: 250)
        var lastRight: CGFloat = -.infinity
        for (index, form) in placed.enumerated() {
            var parts: [ClosedRange<CGFloat>] = []
            if form == .both || form == .before {
                parts.append((xs[index] - Layout.inset - before[index]) ... (xs[index] - Layout.inset))
            }
            if form == .both || form == .after {
                parts.append((xs[index] + Layout.inset) ... (xs[index] + Layout.inset + after[index]))
            }
            for part in parts {
                #expect(part.lowerBound >= 0 && part.upperBound <= 250)
            }
            if let first = parts.first, let last = parts.last {
                #expect(first.lowerBound >= lastRight + Layout.gap - 0.001)
                lastRight = last.upperBound
            }
        }
    }
}
