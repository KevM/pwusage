import SwiftUI

/// Sizes of the drawn battery: the Lock Screen card's background, the expanded
/// Dynamic Island bar, and the compact/minimal Dynamic Island glyph.
enum BatteryGaugeStyle {
    case card, bar, mini

    /// A dash vanishes at mini size, so the mini hold mark is a solid tick instead.
    var dashedHoldLine: Bool { self != .mini }

    var metrics: BatteryGaugeMetrics {
        switch self {
        case .card:
            .init(insets: .init(top: 8, leading: 8, bottom: 8, trailing: 18), nubGap: 3, nubWidth: 5,
                  nubHeightFraction: 0.3, cornerRadius: 16, lineWidth: 1.5, holdLineWidth: 2)
        case .bar:
            .init(insets: .init(top: 0, leading: 0, bottom: 0, trailing: 4), nubGap: 1.5, nubWidth: 2.5,
                  nubHeightFraction: 0.4, cornerRadius: nil, lineWidth: 1.8, holdLineWidth: 2)
        case .mini:
            .init(insets: .init(top: 3, leading: 0.5, bottom: 3, trailing: 3.5), nubGap: 1, nubWidth: 2,
                  nubHeightFraction: 0.4, cornerRadius: nil, lineWidth: 1.4, holdLineWidth: 2)
        }
    }
}

struct BatteryGaugeMetrics {
    /// From the frame to the outline.
    let insets: EdgeInsets
    let nubGap: CGFloat
    let nubWidth: CGFloat
    let nubHeightFraction: CGFloat
    /// nil: a fraction of the outline's height.
    let cornerRadius: CGFloat?
    let lineWidth: CGFloat
    let holdLineWidth: CGFloat
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
    /// The held reserve: a line inside the outline, shortened where the corners curve in.
    let holdLine: CGRect?

    init(style: BatteryGaugeStyle, size: CGSize, charge: Double?, holdLevel: Int?) {
        let metrics = style.metrics
        let body = CGRect(x: metrics.insets.leading, y: metrics.insets.top,
                          width: max(0, size.width - metrics.insets.leading - metrics.insets.trailing),
                          height: max(0, size.height - metrics.insets.top - metrics.insets.bottom))
        let inner = body.insetBy(dx: metrics.lineWidth, dy: metrics.lineWidth)
        let nubHeight = body.height * metrics.nubHeightFraction
        self.body = body
        self.inner = inner
        nub = CGRect(
            x: body.maxX + metrics.nubGap, y: body.midY - nubHeight / 2,
            width: metrics.nubWidth, height: nubHeight)
        cornerRadius = metrics.cornerRadius ?? body.height * 0.32
        lineWidth = metrics.lineWidth
        if let charge, charge.isFinite {
            let fraction = min(max(charge, 0), 100) / 100
            fill = CGRect(x: inner.minX, y: inner.minY, width: inner.width * fraction, height: inner.height)
        } else {
            fill = nil
        }
        if let holdLevel {
            let holdWidth = metrics.holdLineWidth
            let level = CGFloat(min(max(holdLevel, 0), 100)) / 100
            let lineX = min(
                max(inner.minX + inner.width * level, inner.minX + holdWidth / 2), inner.maxX - holdWidth / 2)
            // Near either end the inner shape's rounded corners curve in, so a full-height
            // line would poke past the outline (most visibly at a 100% hold).
            let cornerInset = Self.cornerInset(
                lineX: lineX, in: inner,
                radius: max(0, (metrics.cornerRadius ?? body.height * 0.32) - metrics.lineWidth))
            let top = inner.minY + cornerInset
            let bottom = inner.maxY - cornerInset
            holdLine = CGRect(x: lineX - holdWidth / 2, y: top, width: holdWidth, height: bottom - top)
        } else {
            holdLine = nil
        }
    }

    /// How far a vertical line at `lineX` must stop short of the top and bottom to stay
    /// inside a rounded rect. The radius is padded because the drawn corners are
    /// continuous, which curve in sooner than circular ones; the inset is capped so at
    /// least 40% of the line remains.
    private static func cornerInset(lineX: CGFloat, in rect: CGRect, radius: CGFloat) -> CGFloat {
        let cornerRadius = min(radius * 1.5, rect.height / 2, rect.width / 2)
        let fromEdge = max(0, min(lineX - rect.minX, rect.maxX - lineX))
        guard cornerRadius > 0, fromEdge < cornerRadius else { return 0 }
        let distance = cornerRadius - fromEdge
        return min(cornerRadius - (cornerRadius * cornerRadius - distance * distance).squareRoot(), rect.height * 0.3)
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
            let gauge = BatteryGaugeGeometry(
                style: style, size: proxy.size, charge: charge, holdLevel: isFinal ? nil : holdLevel)
            let faint = isFinal ? 0.6 : 1.0
            let outline = Color.primary.opacity((style == .card ? 0.16 : 0.45) * faint)
            ZStack(alignment: .topLeading) {
                if let fill = gauge.fill, fill.width > 0 {
                    Path(fill)
                        .fill(fillStyle)
                        .clipShape(
                            Path(roundedRect: gauge.inner,
                                 cornerRadius: max(0, gauge.cornerRadius - gauge.lineWidth), style: .continuous))
                }
                Path(roundedRect: gauge.body, cornerRadius: gauge.cornerRadius, style: .continuous)
                    .stroke(outline, lineWidth: gauge.lineWidth)
                Path(roundedRect: gauge.nub, cornerRadius: gauge.nub.width / 2)
                    .fill(outline)
                if let line = gauge.holdLine {
                    if style.dashedHoldLine {
                        Path { path in
                            path.move(to: CGPoint(x: line.midX, y: line.minY))
                            path.addLine(to: CGPoint(x: line.midX, y: line.maxY))
                        }
                        .stroke(
                            Color.accentColor,
                            style: StrokeStyle(lineWidth: line.width, dash: style == .card ? [5, 4] : [3, 2.5]))
                    } else {
                        Path(roundedRect: line, cornerRadius: line.width / 2)
                            .fill(Color.accentColor)
                    }
                }
            }
        }
    }

    /// A subtle left-to-right gradient that deepens toward the live charge edge, so the
    /// card's text sits over the faintest part. Stale charge stays a flat gray.
    private var fillStyle: AnyShapeStyle {
        let fade = isFinal ? 0.5 : 1.0
        guard !isStale else {
            return AnyShapeStyle(Color.secondary.opacity((style == .card ? 0.18 : 0.55) * fade))
        }
        let (start, end) = style == .card ? (0.06, 0.30) : (0.40, 0.70)
        return AnyShapeStyle(LinearGradient(
            colors: [Color.green.opacity(start * fade), Color.green.opacity(end * fade)],
            startPoint: .leading, endPoint: .trailing))
    }
}
