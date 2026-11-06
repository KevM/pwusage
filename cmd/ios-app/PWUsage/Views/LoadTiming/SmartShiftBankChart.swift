import SwiftUI

struct SmartShiftBankChart: View {
    let bars: [SmartShiftBar]
    let slot: SmartShiftSlot?
    let selection: SmartShiftChoiceID
    let marks: SmartShiftChoiceID
    let isSlotHeld: Bool
    var isPopping = false
    let onTapSlot: () -> Void

    private let plotHeight: CGFloat = 240
    private var showsSlot: Bool { selection == .now || isSlotHeld }

    var body: some View {
        let geometry = SmartShiftBarGeometry(bars: bars, slot: slot, plotHeight: plotHeight)
        VStack(spacing: 6) {
            ZStack(alignment: .top) {
                Rectangle().fill(.primary).frame(height: 1.5).offset(y: geometry.zeroY - 0.75)
                    .accessibilityHidden(true)
                HStack(alignment: .top, spacing: 0) {
                    ForEach(bars, id: \.periodKey) { bar in
                        column(bar, geometry: geometry)
                    }
                }
            }
            .frame(height: geometry.height)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(bars.map { "\($0.name), \($0.state(for: marks).total)" }.joined(separator: ". "))
            HStack(alignment: .top, spacing: 0) {
                ForEach(bars, id: \.periodKey) { bar in
                    nameLabel(bar)
                }
            }
        }
        .frame(maxWidth: 500)
    }

    private func nameLabel(_ bar: SmartShiftBar) -> some View {
        VStack(spacing: 2) {
            Text(bar.name).font(.caption.weight(.semibold))
            Text(bar.rate).font(.caption2).foregroundStyle(.secondary)
            let state = bar.state(for: marks)
            if let label = state.badgeLabel, let badge = state.badge {
                Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .background(Self.color(for: badge), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .top)
    }

    private func column(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry) -> some View {
        GeometryReader { proxy in
            let width = min(70, proxy.size.width * 0.6)
            let center = proxy.size.width / 2
            ZStack(alignment: .topLeading) {
                bank(bar, geometry: geometry, width: width, center: center)
                run(bar, geometry: geometry, width: width, center: center)
                Text(bar.state(for: selection).total).font(.caption.weight(.semibold)).lineLimit(1).fixedSize()
                    .position(x: center, y: geometry.totalLabelCenter(of: bar, for: selection, showsSlot: showsSlot))
                badge(bar, geometry: geometry, width: width, center: center)
                saving(bar, geometry: geometry, width: width, center: center)
            }
        }
    }

    @ViewBuilder
    private func bank(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry,
                      width: CGFloat, center: CGFloat) -> some View {
        let base = geometry.base(of: bar)
        if let stump = geometry.stump(of: bar) {
            let isOwed = bar.baselinePosition > 0
            SmartShiftTornEdge(edge: isOwed ? .top : .bottom).fill(Self.bankFill)
                .placedOnBar(stump, width: width, center: center)
            SmartShiftTornEdge(edge: isOwed ? .bottom : .top).fill(Self.bankFill)
                .placedOnBar(base, width: width, center: center)
        } else {
            RoundedRectangle(cornerRadius: 4).fill(Self.bankFill).placedOnBar(base, width: width, center: center)
        }
    }

    @ViewBuilder
    private func run(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry,
                     width: CGFloat, center: CGFloat) -> some View {
        let block = geometry.block(of: bar, for: selection)
        let middle = (block.lowerBound + block.upperBound) / 2
        RoundedRectangle(cornerRadius: 4).fill(Color.emphasis).placedOnBar(block, width: width, center: center)
        if let label = bar.state(for: selection).runLabel {
            if geometry.labelFitsInside(bar, for: selection) {
                Text(label).font(.caption.weight(.bold)).foregroundStyle(Color.onEmphasis)
                    .position(x: center, y: middle)
            } else {
                Text(label).font(.caption.weight(.bold)).foregroundStyle(Color.emphasis).fixedSize()
                    .position(x: center - width / 2 - 16, y: middle)
            }
        }
    }

    @ViewBuilder
    private func badge(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry,
                       width: CGFloat, center: CGFloat) -> some View {
        if let badge = bar.state(for: marks).badge, !isSlotHeld || badge != .priciest {
            let block = geometry.block(of: bar, for: selection)
            Image(systemName: badge == .cheapest ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(Self.color(for: badge))
                .background(Circle().fill(Color(.systemBackground)))
                .scaleEffect(badge == .cheapest && isPopping ? 1.15 : 1)
                .position(x: center + width / 2, y: (block.lowerBound + block.upperBound) / 2)
        }
    }

    @ViewBuilder
    private func saving(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry,
                        width: CGFloat, center: CGFloat) -> some View {
        if showsSlot, let slot, let range = geometry.slot(on: bar) {
            Button(action: onTapSlot) {
                Text(slot.label).font(.caption2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.8)
                    .frame(width: width, height: range.upperBound - range.lowerBound)
                    .background(.green.opacity(0.12))
                    .overlay(RoundedRectangle(cornerRadius: 4)
                        .stroke(.green, style: StrokeStyle(lineWidth: 1, dash: [4])))
            }
            .disabled(isSlotHeld)
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            .position(x: center, y: (range.lowerBound + range.upperBound) / 2)
            .accessibilityLabel(slot.accessibilityLabel)
        }
    }

    private static let bankFill = Color.secondary.opacity(0.2)
    private static func color(for badge: SmartShiftBadge) -> Color { badge == .cheapest ? .green : .red }
}

extension View {
    func placedOnBar(_ range: ClosedRange<CGFloat>, width: CGFloat, center: CGFloat) -> some View {
        frame(width: width, height: range.upperBound - range.lowerBound)
            .position(x: center, y: (range.lowerBound + range.upperBound) / 2)
    }
}
