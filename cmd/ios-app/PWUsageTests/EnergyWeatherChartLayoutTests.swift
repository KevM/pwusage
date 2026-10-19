import Foundation
import Testing
@testable import PWUsage

struct EnergyWeatherChartLayoutTests {
    private typealias Layout = SwitchLabelLayout

    @Test func roomyChartShowsEveryFullLabel() {
        // Landscape: 700 pt wide, full labels 140 pt wide with at least 6 pt between them.
        let placed = Layout.place(xs: [28, 230, 400, 580], fullWidths: [140, 140, 140, 140], shortWidths: [60, 60, 60, 60],
                                  chartWidth: 700)
        #expect(placed == [.full, .full, .full, .full])
    }

    @Test func narrowChartFallsBackToShortLabelsInsteadOfOverlapping() {
        // Portrait: 250 pt wide. The first label is pinned to the left edge (0–140);
        // the next centred at 128 can't fit in full (58–198) or short (98–158), so it's
        // skipped; at 203 the short label (173–233) fits.
        let placed = Layout.place(xs: [10, 128, 203], fullWidths: [140, 140, 140], shortWidths: [60, 60, 60],
                                  chartWidth: 250)
        #expect(placed == [.full, .hidden, .short])
    }

    @Test func placedLabelsNeverOverlapOrLeaveTheChart() {
        let xs: [CGFloat] = [5, 40, 90, 120, 180, 240]
        let full = [CGFloat](repeating: 130, count: xs.count), short = [CGFloat](repeating: 55, count: xs.count)
        let placed = Layout.place(xs: xs, fullWidths: full, shortWidths: short, chartWidth: 250)
        var lastRight: CGFloat = -.infinity
        for (index, form) in placed.enumerated() where form != .hidden {
            let width = form == .full ? full[index] : short[index]
            let left = min(max(xs[index] - width / 2, 0), 250 - width)
            #expect(left >= lastRight + Layout.gap - 0.001)
            #expect(left >= 0 && left + width <= 250)
            lastRight = left + width
        }
    }
}
