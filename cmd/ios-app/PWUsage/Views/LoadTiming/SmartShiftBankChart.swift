import SwiftUI

struct SmartShiftBankChart: View {
    let bars: [SmartShiftBar]
    let slot: SmartShiftSlot?
    let selection: SmartShiftChoiceID
    let marks: SmartShiftChoiceID
    let isSlotHeld: Bool
    var isPopping = false
    let onTapSlot: () -> Void
    var tappedBarKey: String?
    var onTapBar: (String) -> Void = { _ in }

    private let plotHeight: CGFloat = 240
    private var showsSlot: Bool { selection == .now || isSlotHeld }

    var body: some View {
        let geometry = SmartShiftBarGeometry(bars: bars, slot: slot, plotHeight: plotHeight)
        ZStack(alignment: .top) {
            Rectangle().fill(.primary).frame(height: 1.5).offset(y: geometry.zeroY - 0.75)
                .accessibilityHidden(true)
            netZeroLabel(geometry)
            HStack(alignment: .top, spacing: 0) {
                ForEach(bars, id: \.periodKey) { bar in
                    column(bar, geometry: geometry)
                }
            }
        }
        .frame(height: geometry.totalHeight)
        .accessibilityElement(children: .contain)
        .frame(maxWidth: 500)
    }

    private func netZeroLabel(_ geometry: SmartShiftBarGeometry) -> some View {
        GeometryReader { proxy in
            if let slot = SmartShiftBarGeometry.netZeroLabelSlot(count: bars.count, width: proxy.size.width) {
                Text("Net zero").font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .frame(width: slot.width)
                    .position(x: slot.center, y: geometry.zeroY + 11)
            }
        }
    }

    private func nameLabel(_ bar: SmartShiftBar) -> some View {
        VStack(spacing: 2) {
            Text(bar.name).font(.caption.weight(.semibold))
                .foregroundStyle(bar.periodKey == tappedBarKey ? Color.emphasis : Color.primary)
            Text(bar.rate).font(.caption2).foregroundStyle(.secondary)
            let state = bar.state(for: marks)
            if let label = state.badgeLabel, let badge = state.badge {
                Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .background(Self.color(for: badge), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bar.state(for: selection).explanation)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTapBar(bar.periodKey) }
    }

    private func column(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry) -> some View {
        GeometryReader { proxy in
            let width = min(70, proxy.size.width * 0.6)
            let center = proxy.size.width / 2
            ZStack(alignment: .topLeading) {
                bank(bar, geometry: geometry, width: width, center: center)
                run(bar, geometry: geometry, width: width, center: center)
                Text(bar.state(for: selection).total).font(.caption.weight(.semibold)).lineLimit(1)
                    .minimumScaleFactor(0.8).frame(width: proxy.size.width - 4)
                    .position(x: center, y: geometry.totalLabelCenter(of: bar, for: selection, showsSlot: showsSlot))
                badge(bar, geometry: geometry, width: width, center: center)
                saving(bar, geometry: geometry, width: width, center: center)
                nameLabel(bar).offset(y: geometry.nameTop(of: bar))
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .onTapGesture { onTapBar(bar.periodKey) }
        }
    }

    @ViewBuilder
    private func bank(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry,
                      width: CGFloat, center: CGFloat) -> some View {
        let base = geometry.base(of: bar)
        if let stump = geometry.stump(of: bar) {
            let isOwed = bar.baselinePosition > 0
            SmartShiftBarCut(edge: isOwed ? .top : .bottom).fill(Self.bankFill)
                .placedOnBar(stump, width: width, center: center)
            SmartShiftBarCut(edge: isOwed ? .bottom : .top).fill(Self.bankFill)
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
        // The badge straddles the block's right edge, so the label keeps clear of it.
        let badgeRoom: CGFloat = bar.state(for: marks).badge == nil ? 0 : 10
        RoundedRectangle(cornerRadius: 4).fill(Color.emphasis).placedOnBar(block, width: width, center: center)
        if let label = bar.state(for: selection).runLabel {
            if geometry.labelFitsInside(bar, for: selection) {
                Text("\(label) kWh").font(.caption.weight(.bold)).foregroundStyle(Color.onEmphasis)
                    .lineLimit(1).minimumScaleFactor(0.6).frame(width: width - 8 - badgeRoom)
                    .position(x: center - badgeRoom / 2, y: middle)
            } else {
                let margin = center - width / 2
                Text("\(label) kWh").font(.caption.weight(.bold)).foregroundStyle(Color.emphasis)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .frame(width: margin - 4, alignment: .trailing)
                    .position(x: margin / 2 - 2, y: middle)
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
                Text(slot.label).font(.caption2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.5)
                    .padding(.horizontal, 5)
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
