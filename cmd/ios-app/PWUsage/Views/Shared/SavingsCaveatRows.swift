import SwiftUI

struct SavingsCaveatRows: View {
    let caveats: [SavingsCaveat]
    let onAction: (SavingsCaveat.Action) -> Void

    var body: some View {
        ForEach(caveats) { caveat in
            VStack(alignment: .leading, spacing: 4) {
                Divider()
                    .padding(.vertical, 4)
                Text(caveat.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button(caveat.actionTitle) { onAction(caveat.action) }
                    .font(.caption.weight(.medium))
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                    .buttonStyle(.borderless)
            }
        }
    }
}
