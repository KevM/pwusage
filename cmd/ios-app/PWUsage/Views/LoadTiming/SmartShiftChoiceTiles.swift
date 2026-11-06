import SwiftUI

struct SmartShiftChoiceTiles: View {
    let choices: [SmartShiftChoice]
    let selected: SmartShiftChoiceID
    var isPopping = false
    let onSelect: (SmartShiftChoiceID) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var selectionShape

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { tiles }
            } else {
                HStack(spacing: 8) { tiles }
            }
        }
    }

    @ViewBuilder private var tiles: some View {
        ForEach(choices, id: \.id) { choice in
            if choices.count == 1 {
                tile(choice)
            } else {
                Button { onSelect(choice.id) } label: { tile(choice) }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(choice.id == selected ? .isSelected : [])
            }
        }
    }

    private func tile(_ choice: SmartShiftChoice) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(choice.label).font(.caption.weight(.semibold))
            Text(choice.price).font(.title2.weight(.bold)).contentTransition(.numericText())
            Text(choice.caption).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            if choice.id == selected {
                RoundedRectangle(cornerRadius: 12).stroke(Color.emphasis, lineWidth: 2)
                    .matchedGeometryEffect(id: "selection", in: selectionShape)
            }
        }
        .scaleEffect(choice.id == selected && isPopping ? 1.05 : 1)
        .accessibilityElement(children: .combine)
    }
}
