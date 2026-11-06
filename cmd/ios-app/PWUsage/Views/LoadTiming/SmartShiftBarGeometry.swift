import CoreGraphics

struct SmartShiftBarGeometry {
    static let minimumSlotHeight: CGFloat = 22
    static let minimumBlockHeight: CGFloat = 3
    static let minimumLabelledBlockHeight: CGFloat = 12

    private let lower: Double
    private let upper: Double
    private let height: CGFloat
    private let savedSlot: SmartShiftSlot?

    init(bars: [SmartShiftBar], slot: SmartShiftSlot?, plotHeight: CGFloat) {
        let positions = [0.0] + bars.flatMap { [$0.baselinePosition, $0.now.totalPosition,
                                                $0.recommended.totalPosition] }
        lower = positions.min() ?? 0
        upper = max(positions.max() ?? 0, lower + 0.001)
        height = max(plotHeight, Self.minimumSlotHeight + 1)
        savedSlot = slot
    }

    func y(_ position: Double) -> CGFloat {
        let usable = height - Self.minimumSlotHeight
        return Self.minimumSlotHeight + CGFloat((upper - position) / (upper - lower)) * usable
    }

    func base(of bar: SmartShiftBar) -> ClosedRange<CGFloat> {
        let start = y(0)
        let end = y(bar.baselinePosition)
        return min(start, end) ... max(start, end)
    }

    func block(of bar: SmartShiftBar, for id: SmartShiftChoiceID) -> ClosedRange<CGFloat> {
        let state = bar.state(for: id)
        let bottom = y(bar.baselinePosition)
        let top = y(state.totalPosition)
        return (state.runKwh > 0 ? min(top, bottom - Self.minimumBlockHeight) : bottom) ... bottom
    }

    func labelFitsInside(_ bar: SmartShiftBar, for id: SmartShiftChoiceID) -> Bool {
        let range = block(of: bar, for: id)
        return range.upperBound - range.lowerBound >= Self.minimumLabelledBlockHeight
    }

    func slot(on bar: SmartShiftBar) -> ClosedRange<CGFloat>? {
        guard let savedSlot, savedSlot.periodKey == bar.periodKey else { return nil }
        let bottom = y(bar.now.totalPosition)
        let top = min(y(bar.now.totalPosition + savedSlot.extraKwh), bottom - Self.minimumSlotHeight)
        return max(0, top) ... bottom
    }

    static func barWidth(count: Int, in width: CGFloat) -> CGFloat {
        guard count > 0 else { return 0 }
        return max(0, min(70, width / CGFloat(count) * 0.6))
    }
}
