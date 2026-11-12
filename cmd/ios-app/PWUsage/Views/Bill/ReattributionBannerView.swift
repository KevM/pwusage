import SwiftUI

struct ReattributionBannerView: View {
    let status: ReattributionStatusDTO
    let isRetrying: Bool
    let onRetry: () -> Void

    var body: some View {
        switch status.status {
        case .pending, .running:
            runningBanner
        case .failed:
            failedBanner
        case .idle:
            EmptyView()
        }
    }

    private var runningBanner: some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text("Updating historical rates · \(status.processedDays) of \(status.totalDays) days")
                    .font(.subheadline.weight(.medium))
                Text("Costs across saved days are being recalculated.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var failedBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Could not finish updating history")
                    .font(.subheadline.weight(.medium))
                if let errorText = status.lastError, !errorText.isEmpty {
                    Text(errorText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Button("Retry", action: onRetry)
                .emphasisProminentButton()
                .controlSize(.small)
                .disabled(isRetrying)
        }
        .padding(14)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
