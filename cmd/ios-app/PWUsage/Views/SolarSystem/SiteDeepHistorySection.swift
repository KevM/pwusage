import SwiftUI

/// "Older History": the choice to load every day Tesla still has for the site, past the year the
/// layout search reads, with how far back it has loaded.
struct SiteDeepHistorySection: View {
    let model: SiteDeepHistoryModel

    @Environment(\.reconnectTesla) private var reconnectTesla

    var body: some View {
        let presentation = SiteDeepHistoryPresentation(status: model.status)
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if model.status.isLoading { ProgressView() }
                    Text(presentation.statusLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let action = presentation.action { button(action) }
            }
        } header: {
            Text(presentation.title)
        }
    }

    @ViewBuilder private func button(_ action: SiteDeepHistoryPresentation.Action) -> some View {
        switch action {
        case .load:
            Button("Load More History") { model.start() }
        case .continueLoading:
            Button("Continue Loading") { model.start() }
        case .stop:
            Button("Stop") { Task { await model.stop() } }
        case .reconnectTesla:
            if let reconnectTesla {
                Button("Reconnect Tesla") { Task { await reconnectTesla.perform() } }
                    .emphasisProminentButton()
            }
        }
    }
}
