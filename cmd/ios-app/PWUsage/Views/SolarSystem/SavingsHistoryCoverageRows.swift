import SwiftUI

/// The note, and the action that loads more, when savings or payback cover only part of the
/// site's history.
struct SavingsHistoryCoverageRows: View {
    let coverage: SavingsHistoryCoverage
    let notePath: KeyPath<SavingsHistoryCoverage, String?>
    let onAction: (SiteDeepHistoryPresentation.Action) -> Void

    var body: some View {
        if let note = coverage[keyPath: notePath] {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if case .loading = coverage {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let action = coverage.action, let title = coverage.actionTitle {
                    // Borderless, so only the button acts in a row with other content.
                    Button(title) { onAction(action) }
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.borderless)
                }
            }
        }
    }
}
