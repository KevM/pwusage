import SwiftUI

struct SmartShiftBankChart: View {
    let bars: [SmartShiftBar]
    let slot: SmartShiftSlot?
    let selection: SmartShiftChoiceID
    let marks: SmartShiftChoiceID
    let isSlotHeld: Bool
    let onTapSlot: () -> Void

    private let plotHeight: CGFloat = 200

    var body: some View {
        let geometry = SmartShiftBarGeometry(bars: bars, slot: slot, plotHeight: plotHeight)
        VStack(spacing: 5) {
            HStack(alignment: .top, spacing: 4) {
                ForEach(bars, id: \.periodKey) { bar in
                    column(bar, geometry: geometry)
                }
            }
            .frame(height: plotHeight)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(bars.map { "\($0.name), \($0.state(for: marks).total)" }.joined(separator: ". "))
            HStack(alignment: .top, spacing: 4) {
                ForEach(bars, id: \.periodKey) { bar in
                    VStack(spacing: 2) {
                        Text(bar.name).font(.caption.weight(.semibold))
                        Text(bar.rate).font(.caption2).foregroundStyle(.secondary)
                        if let label = bar.state(for: marks).badgeLabel {
                            Text(label).font(.caption2.weight(.semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(maxWidth: 500)
    }

    private func column(_ bar: SmartShiftBar, geometry: SmartShiftBarGeometry) -> some View {
        let base = geometry.base(of: bar)
        let block = geometry.block(of: bar, for: selection)
        let state = bar.state(for: selection)
        return GeometryReader { proxy in
            let width = min(70, proxy.size.width * 0.6)
            ZStack(alignment: .top) {
                Rectangle().fill(.secondary.opacity(0.15)).frame(height: 1).offset(y: geometry.y(0))
                RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.2))
                    .frame(width: width, height: base.upperBound - base.lowerBound).offset(y: base.lowerBound)
                RoundedRectangle(cornerRadius: 4).fill(Color.emphasis)
                    .frame(width: width, height: block.upperBound - block.lowerBound).offset(y: block.lowerBound)
                if let label = state.runLabel {
                    Text(label).font(.caption2.weight(.bold))
                        .foregroundStyle(geometry.labelFitsInside(bar, for: selection)
                            ? Color.onEmphasis : Color.primary)
                        .offset(x: geometry.labelFitsInside(bar, for: selection) ? 0 : width / 2, y: block.lowerBound)
                }
                Text(state.total).font(.caption2.weight(.semibold))
                    .offset(y: state.total == "0" || state.totalPosition >= 0
                        ? geometry.y(max(0, state.totalPosition)) - 18
                        : geometry.y(state.totalPosition) + 2)
                if let badge = bar.state(for: marks).badge, !isSlotHeld || badge != .priciest {
                    Image(systemName: badge == .cheapest ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(badge == .cheapest ? .green : .red)
                        .offset(y: block.lowerBound - 8)
                }
                if selection == .now || isSlotHeld, let slot, let range = geometry.slot(on: bar) {
                    Button(action: onTapSlot) {
                        Text(slot.label).font(.caption2.weight(.bold))
                            .frame(width: width, height: range.upperBound - range.lowerBound)
                            .background(.green.opacity(0.12))
                            .overlay(RoundedRectangle(cornerRadius: 4)
                                .stroke(.green, style: StrokeStyle(lineWidth: 1, dash: [4])))
                    }
                    .disabled(isSlotHeld)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    .offset(y: range.lowerBound - max(0, (44 - (range.upperBound - range.lowerBound)) / 2))
                    .accessibilityLabel(slot.accessibilityLabel)
                }
            }.frame(maxWidth: .infinity, alignment: .top)
        }
    }
}
