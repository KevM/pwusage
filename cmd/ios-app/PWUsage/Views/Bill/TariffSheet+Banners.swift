import SwiftUI

/// Banners and rows shared by Rate Plans; split out to keep TariffSheet within its length budget.
extension TariffSheet {
    func timelineGapRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(.secondary.opacity(0.4))
        )
    }

    func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
            Text(message).font(.caption).foregroundStyle(.red)
            Spacer()
        }
        .padding(12)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    func teslaDivergenceBanner(_ sync: TeslaSyncDTO, isSyncing: Bool, onSync: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.badge.clock")
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                let copy = TeslaDivergenceCopy(sync: sync)
                Text(copy.title)
                    .font(.subheadline.weight(.medium))
                Text(copy.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Sync", action: onSync)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isSyncing)
        }
        .padding(14)
        .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
