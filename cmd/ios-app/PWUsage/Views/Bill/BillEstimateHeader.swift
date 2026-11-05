import SwiftUI

/// The two totals the Bill tab opens on: the bill so far and where it is heading.
struct BillEstimateHeader: View {
    enum Projection: Equatable {
        case none, pending
        case amount(Double, label: String)
    }

    let soFar: Double?
    let currency: String
    let projection: Projection
    /// Nil hides the bar, for a credit or a bill the bar cannot show truthfully.
    let fillFraction: Double?
    let daysLeft: String?
    var isSelected = true
    /// Off for still renders, which never get an `onAppear`.
    var animatesReveal = true
    var onInfo: (() -> Void)?
    var scrollSpace = ""
    var onAmountBottomChange: ((CGFloat) -> Void)?

    @State private var isRevealed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var reveal: Double { isRevealed || reduceMotion || !animatesReveal ? 1 : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            totals
            if let fillFraction {
                BillFillBar(fraction: fillFraction * reveal)
            }
            footnote
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(17)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .onAppear { if isSelected { revealAnimated() } }
        .onChange(of: isSelected) { _, selected in
            if selected { revealAnimated() } else { isRevealed = false }
        }
    }

    @ViewBuilder private var totals: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) { soFarColumn; projectionColumn(alignment: .leading) }
        } else {
            HStack(alignment: .lastTextBaseline, spacing: 12) {
                soFarColumn
                Spacer(minLength: 8)
                projectionColumn(alignment: .trailing)
            }
        }
    }

    private var soFarColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("So far").font(.caption).foregroundStyle(.secondary)
            Group {
                if let soFar {
                    rollingAmount(DashboardPresentation.currency(soFar * reveal, code: currency), value: soFar * reveal)
                } else {
                    Text(DashboardPresentation.currency(nil, code: currency))
                }
            }
            .font(.system(.title, design: .rounded, weight: .bold))
            .lineLimit(1).minimumScaleFactor(0.75)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("So far, \(DashboardPresentation.currency(soFar, code: currency))")
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .named(scrollSpace)).maxY
        } action: { onAmountBottomChange?($0) }
    }

    @ViewBuilder private func projectionColumn(alignment: HorizontalAlignment) -> some View {
        switch projection {
        case .none:
            EmptyView()
        case .pending:
            VStack(alignment: alignment, spacing: 2) {
                Text("By cycle end").font(.caption).foregroundStyle(.secondary)
                Text("Estimating").font(.headline).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        case let .amount(cost, label):
            VStack(alignment: alignment, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                rollingAmount(BillOutlookPresentation.projectedAmount(cost * reveal, currency: currency),
                              value: cost * reveal)
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(Color.emphasis)
                    .lineLimit(1).minimumScaleFactor(0.75)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(label), \(BillOutlookPresentation.projectedAmount(cost, currency: currency))")
        }
    }

    private func rollingAmount(_ text: String, value: Double) -> some View {
        Text(text)
            .monospacedDigit()
            .contentTransition(reduceMotion ? .identity : .numericText(value: value))
    }

    private var footnote: some View {
        HStack {
            if let onInfo {
                Button(action: onInfo) {
                    Image(systemName: "info.circle").font(.subheadline)
                }
                .accessibilityLabel("About this estimate")
            }
            Spacer(minLength: 8)
            if let daysLeft {
                Text(daysLeft).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func revealAnimated() {
        guard !isRevealed else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 1)) { isRevealed = true }
    }
}

/// Solid up to the bill so far, hatched for what is still expected.
private struct BillFillBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                hatching
                Capsule()
                    .fill(Color.emphasis)
                    .frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 10)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }

    private var hatching: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color.emphasis.opacity(0.14)))
            let spacing: CGFloat = 8
            var path = Path()
            var start = -size.height
            while start < size.width {
                path.move(to: CGPoint(x: start, y: size.height))
                path.addLine(to: CGPoint(x: start + size.height, y: 0))
                start += spacing
            }
            context.stroke(path, with: .color(Color.emphasis.opacity(0.4)), lineWidth: 4)
        }
    }
}
