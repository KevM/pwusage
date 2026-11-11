import SwiftUI

/// A grid of glyphs to pick from; the chosen one is outlined.
struct JobGlyphPicker: View {
    @Binding var symbol: String?

    private let columns = [GridItem(.adaptive(minimum: 52), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(JobGlyphs.gallery, id: \.self) { name in
                let isSelected = name == symbol
                Button { symbol = name } label: {
                    Image(systemName: name)
                        .font(.title3)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .foregroundStyle(isSelected ? Color.onEmphasis : Color.primary)
                        .background(isSelected ? Color.emphasis : Color.secondary.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(name.replacingOccurrences(of: ".fill", with: "")
                    .replacingOccurrences(of: ".", with: " "))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
    }
}
