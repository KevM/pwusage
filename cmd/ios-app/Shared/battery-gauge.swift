import SwiftUI

/// Sizes of the drawn battery: the Lock Screen card's background, the expanded
/// Dynamic Island bar, and the compact/minimal Dynamic Island glyph.
enum BatteryGaugeStyle {
    case card, bar, mini

    /// A dash vanishes at mini size, so the mini hold mark is a solid tick instead.
    var dashedHoldLine: Bool { self != .mini }

    fileprivate var metrics: BatteryGaugeMetrics {
        switch self {
        case .card:
            .init(insets: .init(top: 8, leading: 8, bottom: 8, trailing: 18), nubGap: 3, nubWidth: 5,
                  nubHeightFraction: 0.3, cornerRadius: 16, lineWidth: 1.5, holdLineWidth: 2, tickOverhang: 0)
        case .bar:
            .init(insets: .init(top: 0, leading: 0, bottom: 0, trailing: 4), nubGap: 1.5, nubWidth: 2.5,
                  nubHeightFraction: 0.4, cornerRadius: nil, lineWidth: 1.8, holdLineWidth: 2, tickOverhang: 0)
        case .mini:
            .init(insets: .init(top: 3, leading: 0.5, bottom: 3, trailing: 3.5), nubGap: 1, nubWidth: 2,
                  nubHeightFraction: 0.4, cornerRadius: nil, lineWidth: 1.4, holdLineWidth: 2, tickOverhang: 2.5)
        }
    }
}

private struct BatteryGaugeMetrics {
    /// From the frame to the outline. Mini insets leave room for the tick's overhang.
    let insets: EdgeInsets
    let nubGap: CGFloat
    let nubWidth: CGFloat
    let nubHeightFraction: CGFloat
    /// nil: a fraction of the outline's height.
    let cornerRadius: CGFloat?
    let lineWidth: CGFloat
    let holdLineWidth: CGFloat
    let tickOverhang: CGFloat
}

/// Where each part of the drawn battery goes in a frame of `size`. Pure, so the
/// rules (unknown charge = no fill, clamping, the line staying inside) are tested.
struct BatteryGaugeGeometry: Equatable {
    /// The outline.
    let body: CGRect
    /// Inside the outline's stroke: where the fill and the dashed line live.
    let inner: CGRect
    let nub: CGRect
    let cornerRadius: CGFloat
    let lineWidth: CGFloat
    /// The charge, from the leading edge. nil when the charge is unknown.
    let fill: CGRect?
    /// The held reserve: a full-height line, or for mini a tick past the outline.
    let holdLine: CGRect?

    init(style: BatteryGaugeStyle, size: CGSize, charge: Double?, holdLevel: Int?) {
        let m = style.metrics
        let body = CGRect(x: m.insets.leading, y: m.insets.top,
                          width: max(0, size.width - m.insets.leading - m.insets.trailing),
                          height: max(0, size.height - m.insets.top - m.insets.bottom))
        let inner = body.insetBy(dx: m.lineWidth, dy: m.lineWidth)
        let nubHeight = body.height * m.nubHeightFraction
        self.body = body
        self.inner = inner
        nub = CGRect(x: body.maxX + m.nubGap, y: body.midY - nubHeight / 2, width: m.nubWidth, height: nubHeight)
        cornerRadius = m.cornerRadius ?? body.height * 0.32
        lineWidth = m.lineWidth
        if let charge, charge.isFinite {
            let fraction = min(max(charge, 0), 100) / 100
            fill = CGRect(x: inner.minX, y: inner.minY, width: inner.width * fraction, height: inner.height)
        } else {
            fill = nil
        }
        if let holdLevel {
            let w = m.holdLineWidth
            let level = CGFloat(min(max(holdLevel, 0), 100)) / 100
            let x = min(max(inner.minX + inner.width * level, inner.minX + w / 2), inner.maxX - w / 2)
            let top = style == .mini ? body.minY - m.tickOverhang : inner.minY
            let bottom = style == .mini ? body.maxY + m.tickOverhang : inner.maxY
            holdLine = CGRect(x: x - w / 2, y: top, width: w, height: bottom - top)
        } else {
            holdLine = nil
        }
    }
}

/// A battery drawn from shapes: a faint outline and nub, a green fill at the live
/// charge, and the held reserve in the accent color. Stale states drop the green
/// (a stale green fill reads as fresh); final states draw fainter, without the hold.
struct BatteryGaugeView: View {
    let style: BatteryGaugeStyle
    let charge: Double?
    let holdLevel: Int?
    var isStale = false
    var isFinal = false

    var body: some View {
        GeometryReader { proxy in
            let g = BatteryGaugeGeometry(style: style, size: proxy.size, charge: charge, holdLevel: isFinal ? nil : holdLevel)
            let faint = isFinal ? 0.6 : 1.0
            let outline = Color.primary.opacity((style == .card ? 0.16 : 0.45) * faint)
            ZStack(alignment: .topLeading) {
                if let fill = g.fill, fill.width > 0 {
                    Path(fill)
                        .fill((isStale ? Color.secondary : Color.green).opacity((style == .card ? 0.18 : 0.55) * (isFinal ? 0.5 : 1)))
                        .clipShape(Path(roundedRect: g.inner, cornerRadius: max(0, g.cornerRadius - g.lineWidth), style: .continuous))
                }
                Path(roundedRect: g.body, cornerRadius: g.cornerRadius, style: .continuous)
                    .stroke(outline, lineWidth: g.lineWidth)
                Path(roundedRect: g.nub, cornerRadius: g.nub.width / 2)
                    .fill(outline)
                if let line = g.holdLine {
                    if style.dashedHoldLine {
                        Path { path in
                            path.move(to: CGPoint(x: line.midX, y: line.minY))
                            path.addLine(to: CGPoint(x: line.midX, y: line.maxY))
                        }
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: line.width, dash: style == .card ? [5, 4] : [3, 2.5]))
                    } else {
                        Path(roundedRect: line, cornerRadius: line.width / 2)
                            .fill(Color.accentColor)
                    }
                }
            }
        }
    }
}
