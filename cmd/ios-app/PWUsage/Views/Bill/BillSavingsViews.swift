import SwiftUI

/// The slim row above the charts. The saving is about the rest of the cycle, so it explains itself in a
/// sheet here rather than sending someone to Smart Shift, which compares start times for one job.
struct BillSavingsRow: View {
    let move: BillSavingsMove
    let currency: String
    let action: () -> Void

    var body: some View {
        let headline = move.rowHeadline(currency: currency)
        Button(action: action) {
            HStack(spacing: 8) {
                Text("\(Text(headline).fontWeight(.semibold)) by cycle end")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.emphasis)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 17)
            .padding(.vertical, 13)
            .background(SectionTheme.secondaryGroupedBackground,
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows how")
    }
}

struct BillSavingsSheet: View {
    let move: BillSavingsMove
    let currency: String
    var onOpenSmartShift: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    summary
                    BillSavingsFlow(move: move, currency: currency)
                    smartShiftAction
                }
                .padding(20)
            }
            .background { SectionTheme.groupedBackground.ignoresSafeArea() }
            .navigationTitle("Before This Cycle Ends")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(move.amount(currency: currency))
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .foregroundStyle(Color.emphasis)
                .monospacedDigit()
            Text(move.headline).font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var smartShiftAction: some View {
        if let onOpenSmartShift {
            VStack(spacing: 6) {
                Button {
                    dismiss()
                    onOpenSmartShift()
                } label: {
                    Text("Time a Job in Smart Shift").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Text("Smart Shift finds the cheapest start for one job.")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

/// Where the energy comes from, how much, and where it goes.
struct BillSavingsFlow: View {
    let move: BillSavingsMove
    let currency: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stacked
            } else {
                ViewThatFits(in: .horizontal) { sideBySide; stacked }
            }
        }
        .padding(12)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(move.accessibilityLabel(currency: currency))
    }

    private var sideBySide: some View {
        HStack(spacing: 4) {
            tile(move.source, wraps: false)
            VStack(spacing: 4) {
                Text("\(move.energyText)\nof use")
                    .font(.caption2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.emphasis)
                    .fixedSize()
                BillFlowDots()
            }
            .frame(minWidth: 58)
            tile(move.destination, wraps: false)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var stacked: some View {
        VStack(spacing: 6) {
            tile(move.source, wraps: true)
            Label("\(move.energyText) of use", systemImage: "arrow.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.emphasis)
            tile(move.destination, wraps: true)
        }
    }

    /// Side by side the text may not wrap, so `ViewThatFits` falls back to stacking long names.
    private func tile(_ side: BillSavingsMove.Side, wraps: Bool) -> some View {
        VStack(spacing: 2) {
            Text(side.title).font(.caption.weight(.semibold))
                .fixedSize(horizontal: !wraps, vertical: false)
            Text(move.rateText(for: side, currency: currency))
                .font(.system(.title2, design: .rounded, weight: .bold))
                .monospacedDigit()
            Text(side.role.caption).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: !wraps, vertical: false)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .background(tint(side.role).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func tint(_ role: BillSavingsMove.Role) -> Color {
        switch role {
        case .pay: EnergyWeatherChart.owedColor
        case .onlyEarn: EnergyWeatherChart.bankedColor
        }
    }
}

/// Dots running toward the arrowhead. Reduce Motion gets a still arrow.
private struct BillFlowDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let period = 1.8
    private static let count = 3

    var body: some View {
        Group {
            if reduceMotion {
                Image(systemName: "arrow.right").font(.caption.weight(.semibold)).foregroundStyle(Color.emphasis)
            } else {
                TimelineView(.animation) { timeline in
                    Canvas { context, size in draw(in: &context, size: size, at: timeline.date) }
                }
            }
        }
        .frame(width: 44, height: 14)
        .accessibilityHidden(true)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, at date: Date) {
        let track = size.width - 8
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
        for index in 0 ..< Self.count {
            let progress = (phase + Double(index) / Double(Self.count)).truncatingRemainder(dividingBy: 1)
            let dot = CGRect(x: track * progress, y: size.height / 2 - 2.5, width: 5, height: 5)
            context.fill(Path(ellipseIn: dot), with: .color(Color.emphasis.opacity(min(1, (1 - progress) * 3))))
        }
        var head = Path()
        head.move(to: CGPoint(x: size.width - 5, y: size.height / 2 - 4))
        head.addLine(to: CGPoint(x: size.width - 1, y: size.height / 2))
        head.addLine(to: CGPoint(x: size.width - 5, y: size.height / 2 + 4))
        context.stroke(head, with: .color(.emphasis),
                       style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
    }
}
