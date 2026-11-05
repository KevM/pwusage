import SwiftUI

/// The timing of the sky sweep shown while Smart Shift waits for today's solar forecast.
///
/// The clouds are decoration in fixed spots. The forecast has not arrived yet, so they say nothing
/// about today's weather.
enum SmartShiftSkySweep {
    /// Seconds for one full turn of the sweep.
    static let period: TimeInterval = 2
    static let wedgeWidth: Double = 36
    static let peakCloudOpacity: Double = 0.85
    /// The faint clouds drawn when the sweep is still, for Reduce Motion.
    static let stillCloudOpacity: Double = 0.35
    /// Degrees behind the sweep at which a cloud has faded out completely.
    private static let cloudFadeArc: Double = 200

    /// A cloud in unit coordinates, where the disc fills a 1×1 square.
    struct Cloud: Equatable {
        let across: Double
        let down: Double
        let radius: Double

        /// Degrees clockwise from north, seen from the middle of the disc.
        var bearing: Double {
            let degrees = atan2(across - 0.5, 0.5 - down) * 180 / .pi
            return degrees < 0 ? degrees + 360 : degrees
        }

        func opacity(sweepBearing: Double) -> Double {
            let behindSweep = (sweepBearing - bearing + 360).truncatingRemainder(dividingBy: 360)
            return max(0, peakCloudOpacity * (1 - behindSweep / cloudFadeArc))
        }
    }

    static let clouds = [
        Cloud(across: 0.28, down: 0.25, radius: 0.10),
        Cloud(across: 0.72, down: 0.33, radius: 0.08),
        Cloud(across: 0.78, down: 0.69, radius: 0.11),
        Cloud(across: 0.33, down: 0.75, radius: 0.08),
        Cloud(across: 0.19, down: 0.53, radius: 0.06)
    ]

    /// Degrees clockwise from north that the leading edge of the sweep points at.
    static func bearing(at elapsed: TimeInterval) -> Double {
        elapsed.truncatingRemainder(dividingBy: period) / period * 360
    }
}

/// The loading state of the Smart Shift card: the sky sweep beside the "checking" note.
struct SmartShiftCheckingSolarRow: View {
    var body: some View {
        HStack(spacing: 12) {
            SmartShiftSkySweepView()
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            Text(SmartShiftPresentation.checkingSolarNote).foregroundStyle(.secondary)
        }
    }
}

private struct SmartShiftSkySweepView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let isSwept = !reduceMotion
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isSwept || scenePhase != .active)) { timeline in
            Canvas { context, size in
                let elapsed = timeline.date.timeIntervalSinceReferenceDate
                let bearing = isSwept ? SmartShiftSkySweep.bearing(at: elapsed) : nil
                SmartShiftSkySweepDrawing(side: min(size.width, size.height)).draw(in: context, sweepBearing: bearing)
            }
        }
    }
}

private struct SmartShiftSkySweepDrawing {
    let side: CGFloat

    private var center: CGPoint { CGPoint(x: side / 2, y: side / 2) }
    private var radius: CGFloat { side / 2 }

    /// A nil bearing draws the still disc, with no sweep.
    func draw(in context: GraphicsContext, sweepBearing: Double?) {
        drawDisc(in: context)
        for cloud in SmartShiftSkySweep.clouds {
            let opacity = sweepBearing.map(cloud.opacity(sweepBearing:)) ?? SmartShiftSkySweep.stillCloudOpacity
            let cloudCenter = CGPoint(x: cloud.across * side, y: cloud.down * side)
            context.fill(circle(at: cloudCenter, radius: cloud.radius * side),
                         with: .color(Color(.systemGray).opacity(opacity)))
        }
        if let sweepBearing {
            context.fill(wedge(leadingEdge: sweepBearing), with: .color(Color(.systemOrange).opacity(0.4)))
        }
        context.fill(circle(at: center, radius: side * 0.1), with: .color(Color(.systemYellow)))
    }

    private func drawDisc(in context: GraphicsContext) {
        let rim = circle(at: center, radius: radius - 1)
        context.fill(rim, with: .color(Color(.systemOrange).opacity(0.08)))
        context.stroke(rim, with: .color(Color(.systemGray).opacity(0.4)), lineWidth: 1)
        context.stroke(circle(at: center, radius: radius * 0.65),
                       with: .color(Color(.systemGray).opacity(0.2)), lineWidth: 1)
    }

    private func circle(at point: CGPoint, radius: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius))
    }

    private func wedge(leadingEdge bearing: Double) -> Path {
        // Angles run from east in Path; bearings run from north.
        var path = Path()
        path.move(to: center)
        path.addArc(center: center, radius: radius - 1,
                    startAngle: .degrees(bearing - SmartShiftSkySweep.wedgeWidth - 90),
                    endAngle: .degrees(bearing - 90), clockwise: false)
        path.closeSubpath()
        return path
    }
}

#if DEBUG
    #Preview("Smart Shift · Checking today's solar") {
        SmartShiftCheckingSolarRow()
            .padding()
    }
#endif
