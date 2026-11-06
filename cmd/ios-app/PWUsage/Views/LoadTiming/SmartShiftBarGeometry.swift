import CoreGraphics

/// Places the bars on one kWh scale fitted to the job, not to the largest bank. A bar too far from
/// zero to fit that scale is torn: a stump stays on the zero line, and the part around the run keeps
/// the shared scale, so runs compare across bars and the printed total carries the true distance.
struct SmartShiftBarGeometry {
    static let minimumSlotHeight: CGFloat = 22
    static let minimumBlockHeight: CGFloat = 3
    static let minimumLabelledBlockHeight: CGFloat = 20
    static let maximumPointsPerKwh: CGFloat = 8
    /// A bar is torn when its baseline is more than this many jobs from zero.
    static let tearThreshold = 1.5
    static let stumpHeight: CGFloat = 14
    static let tearGap: CGFloat = 10
    /// Points between the zero line and the torn part's run, which holds the stump, gap and a gray stub.
    static let tornLift: CGFloat = 46
    /// Room above the tallest bar for a slot's minimum height and the total above it.
    static let headroom: CGFloat = minimumSlotHeight + totalLabelRoom
    private static let totalLabelRoom: CGFloat = 20
    private static let bottomInset: CGFloat = 2

    /// How far something reaches from the zero line: kWh on the shared scale plus fixed points.
    private struct Reach {
        let kwh: Double
        let points: CGFloat
        func total(_ scale: CGFloat) -> CGFloat { CGFloat(kwh) * scale + points }
    }

    let height: CGFloat
    let zeroY: CGFloat
    private let pointsPerKwh: CGFloat
    private let tornKeys: Set<String>
    private let savedSlot: SmartShiftSlot?

    init(bars: [SmartShiftBar], slot: SmartShiftSlot?, plotHeight: CGFloat) {
        let spans = Dictionary(bars.map { ($0.periodKey, Self.span(of: $0, slot: slot)) }) { first, _ in first }
        let job = spans.values.max() ?? 0
        let torn = bars.filter { job > 0 && abs($0.baselinePosition) > job * Self.tearThreshold }
        let tornKeys = Set(torn.map(\.periodKey))

        var above = [Reach(kwh: 0, points: 0)]
        var below = [Reach(kwh: 0, points: 0)]
        for bar in bars {
            let span = spans[bar.periodKey] ?? 0
            if !tornKeys.contains(bar.periodKey) {
                above.append(Reach(kwh: max(0, bar.baselinePosition + span), points: 0))
                below.append(Reach(kwh: max(0, -bar.baselinePosition), points: 0))
            } else if bar.baselinePosition > 0 {
                above.append(Reach(kwh: span, points: Self.tornLift))
            } else {
                below.append(Reach(kwh: span, points: Self.tornLift))
            }
        }

        let available = max(plotHeight - Self.headroom - Self.bottomInset, 1)
        var scale = Self.maximumPointsPerKwh
        for top in above {
            for bottom in below where top.kwh + bottom.kwh > 0 {
                scale = min(scale, max(available - top.points - bottom.points, 1) / CGFloat(top.kwh + bottom.kwh))
            }
        }
        let upward = above.map { $0.total(scale) }.max() ?? 0
        let downward = below.map { $0.total(scale) }.max() ?? 0

        pointsPerKwh = scale
        zeroY = Self.headroom + upward
        height = Self.headroom + upward + downward + Self.bottomInset
        self.tornKeys = tornKeys
        savedSlot = slot
    }

    /// The most kWh this bar ever shows on top of its baseline, including the slot.
    private static func span(of bar: SmartShiftBar, slot: SmartShiftSlot?) -> Double {
        let slotTop = slot?.periodKey == bar.periodKey ? bar.now.runKwh + (slot?.extraKwh ?? 0) : 0
        return max(bar.now.runKwh, bar.recommended.runKwh, slotTop)
    }

    func isTorn(_ bar: SmartShiftBar) -> Bool { tornKeys.contains(bar.periodKey) }

    func y(_ position: Double, on bar: SmartShiftBar) -> CGFloat {
        guard isTorn(bar) else { return zeroY - CGFloat(position) * pointsPerKwh }
        let baseline = bar.baselinePosition
        if baseline > 0 { return zeroY - Self.tornLift - CGFloat(position - baseline) * pointsPerKwh }
        let top = baseline + Self.span(of: bar, slot: savedSlot)
        return zeroY + Self.tornLift + CGFloat(top - position) * pointsPerKwh
    }

    /// The gray bank. On a torn bar, the part beyond the tear.
    func base(of bar: SmartShiftBar) -> ClosedRange<CGFloat> {
        let end = y(bar.baselinePosition, on: bar)
        guard isTorn(bar) else { return min(zeroY, end) ... max(zeroY, end) }
        let tear = Self.stumpHeight + Self.tearGap
        return bar.baselinePosition > 0 ? end ... (zeroY - tear) : (zeroY + tear) ... end
    }

    /// The short piece a torn bar leaves on the zero line.
    func stump(of bar: SmartShiftBar) -> ClosedRange<CGFloat>? {
        guard isTorn(bar) else { return nil }
        return bar.baselinePosition > 0 ? (zeroY - Self.stumpHeight) ... zeroY : zeroY ... (zeroY + Self.stumpHeight)
    }

    func block(of bar: SmartShiftBar, for id: SmartShiftChoiceID) -> ClosedRange<CGFloat> {
        let state = bar.state(for: id)
        let bottom = y(bar.baselinePosition, on: bar)
        let top = y(state.totalPosition, on: bar)
        return (state.runKwh > 0 ? min(top, bottom - Self.minimumBlockHeight) : bottom) ... bottom
    }

    func labelFitsInside(_ bar: SmartShiftBar, for id: SmartShiftChoiceID) -> Bool {
        let range = block(of: bar, for: id)
        return range.upperBound - range.lowerBound >= Self.minimumLabelledBlockHeight
    }

    func slot(on bar: SmartShiftBar) -> ClosedRange<CGFloat>? {
        guard let savedSlot, savedSlot.periodKey == bar.periodKey else { return nil }
        let bottom = y(bar.now.totalPosition, on: bar)
        let top = min(y(bar.now.totalPosition + savedSlot.extraKwh, on: bar), bottom - Self.minimumSlotHeight)
        return max(0, top) ... bottom
    }

    /// The total's vertical center: above whatever the bar shows, and never below the zero line, so
    /// a banked total can't run into the names under the plot.
    func totalLabelCenter(of bar: SmartShiftBar, for id: SmartShiftChoiceID, showsSlot: Bool) -> CGFloat {
        let slotTop = showsSlot ? slot(on: bar)?.lowerBound : nil
        return min(zeroY, block(of: bar, for: id).lowerBound, slotTop ?? .infinity) - Self.totalLabelRoom / 2
    }

    static func barWidth(count: Int, in width: CGFloat) -> CGFloat {
        guard count > 0 else { return 0 }
        return max(0, min(70, width / CGFloat(count) * 0.6))
    }
}
