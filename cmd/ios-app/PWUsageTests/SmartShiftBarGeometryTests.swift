import CoreGraphics
@testable import PWUsage
import Testing

struct SmartShiftBarGeometryTests {
    private func bar(baseline: Double, now: Double, later: Double) -> SmartShiftBar {
        let current = SmartShiftBarState(runKwh: now, totalPosition: baseline + now, runLabel: nil, total: "")
        let recommended = SmartShiftBarState(runKwh: later, totalPosition: baseline + later, runLabel: nil, total: "")
        return SmartShiftBar(periodKey: "test", name: "Test", rate: "", buyRate: 1,
                             baselinePosition: baseline, recommended: recommended, now: current)
    }

    @Test func blockSpansBaselineAndTotal() {
        let value = bar(baseline: -10, now: 24, later: 6)
        let geometry = SmartShiftBarGeometry(bars: [value], slot: nil, plotHeight: 200)
        #expect(geometry.block(of: value, for: .now).contains(geometry.y(0)))
        #expect(geometry.block(of: value, for: .now).lowerBound == geometry.y(14))
        #expect(geometry.block(of: value, for: .now).upperBound == geometry.y(-10))
    }

    @Test func tinyRunKeepsAVisibleSliver() {
        let value = bar(baseline: 50, now: 0.1, later: 80)
        let geometry = SmartShiftBarGeometry(bars: [value], slot: nil, plotHeight: 200)
        let block = geometry.block(of: value, for: .now)
        #expect(block.upperBound - block.lowerBound >= 3)
        #expect(!geometry.labelFitsInside(value, for: .now))
    }
}
