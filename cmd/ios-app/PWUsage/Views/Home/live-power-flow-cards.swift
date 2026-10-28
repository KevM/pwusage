import SwiftUI

struct LivePowerFlowCards: View {
    let flow: DashboardPresentation.PowerFlow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var cards: [DashboardPresentation.PowerCard] { flow.supplying + flow.receiving }
    var flowIsUnknown: Bool { cards.allSatisfy { $0.role == .unknown } }

    var body: some View {
        PowerFlowLayout(stacked: dynamicTypeSize.isAccessibilitySize) {
            heading(flowIsUnknown ? "Last readings" : "Supplying", column: 0)
            heading(flowIsUnknown ? "Flow unknown" : "Receiving", column: 1)
            ForEach(DashboardPresentation.PowerSource.allCases) { source in
                if let card = cards.first(where: { $0.id == source }) {
                    tile(card)
                        .layoutValue(key: FlowColumn.self, value: flow.supplying.contains(card) ? 0 : 1)
                        .layoutValue(key: FlowRow.self, value: (flow.supplying.firstIndex(of: card) ?? flow.receiving.firstIndex(of: card) ?? 0) + 1)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: flow.supplying.map(\.id))
        .transaction { if reduceMotion { $0.disablesAnimations = true } }
    }

    private func heading(_ title: String, column: Int) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
            .accessibilitySortPriority(column == 0 ? 100 : 50)
            .layoutValue(key: FlowColumn.self, value: column)
    }

    private func tile(_ card: DashboardPresentation.PowerCard) -> some View {
        let symbol: String
        let tint: Color
        switch card.id {
        case .solar: symbol = "sun.max.fill"; tint = .orange
        case .home: symbol = "house.fill"; tint = .blue
        case .grid: symbol = card.role == .unknown || card.role == .idle ? "powerplug" : (card.role == .supplying ? "arrow.down.to.line" : "arrow.up.to.line"); tint = .gray
        case .battery: symbol = card.role == .receiving ? "battery.100percent.bolt" : "battery.100percent"; tint = .green
        }
        let role = card.role == .supplying ? "Supplying power" : (card.role == .receiving ? "Receiving power" : nil)
        return MetricTile(title: card.id.title, value: card.watts.map(DashboardPresentation.power) ?? "--",
                          detail: card.detail, symbol: symbol, tint: tint,
                          showsDetail: card.role != .unknown,
                          isMuted: card.role == .idle || card.role == .unknown,
                          numericValue: card.watts, spokenRole: role)
            .accessibilitySortPriority(flow.supplying.firstIndex(of: card).map { Double(99 - $0) }
                ?? Double(49 - (flow.receiving.firstIndex(of: card) ?? 0)))
    }
}

private struct FlowColumn: LayoutValueKey { static let defaultValue = 0 }
private struct FlowRow: LayoutValueKey { static let defaultValue = 0 }

private struct PowerFlowLayout: Layout {
    var stacked: Bool
    private let spacing: CGFloat = 10

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let useStack = stacked || width < 280
        let cardWidth = useStack ? width : (width - spacing) / 2
        let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: cardWidth, height: nil)) }
        var result = Array(repeating: CGRect.zero, count: subviews.count)
        var y: CGFloat = 0
        if useStack {
            for column in 0 ... 1 {
                let indices = subviews.indices.filter { subviews[$0][FlowColumn.self] == column }
                    .sorted { subviews[$0][FlowRow.self] < subviews[$1][FlowRow.self] }
                for index in indices {
                    result[index] = CGRect(x: 0, y: y, width: cardWidth, height: sizes[index].height)
                    y += sizes[index].height + spacing
                }
            }
        } else {
            let maxRow = subviews.map { $0[FlowRow.self] }.max() ?? 0
            for row in 0 ... maxRow {
                let indices = subviews.indices.filter { subviews[$0][FlowRow.self] == row }
                let height = indices.map { sizes[$0].height }.max() ?? 0
                for index in indices {
                    result[index] = CGRect(x: CGFloat(subviews[index][FlowColumn.self]) * (cardWidth + spacing),
                                           y: y, width: cardWidth, height: height)
                }
                y += height + spacing
            }
        }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        return CGSize(width: width, height: frames(width: width, subviews: subviews).map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let positions = frames(width: bounds.width, subviews: subviews)
        for index in subviews.indices {
            let frame = positions[index]
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                                  anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

struct AvailabilityBanner: View {
    let message: String
    let symbol: String
    var body: some View {
        Label(message, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(.orange)
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.11), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
    }
}

struct EmptyCard: View {
    let symbol: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: symbol).font(.title).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}

struct LoadingCard: View {
    let title: String
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(title).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}
