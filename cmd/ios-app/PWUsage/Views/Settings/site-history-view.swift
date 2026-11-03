import SwiftUI

/// Site History in Settings: where loading history for Solar Forecasting stands for this site.
struct SiteHistoryView: View {
    let status: SiteHistoryStatus?
    var debugActions: SiteHistoryDebugActions?
    @Environment(\.reconnectTesla) private var reconnectTesla

    var body: some View {
        // Waiting text names a time, so re-read the clock now and then.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(SiteHistoryPresentation(status: status, now: context.date))
        }
        .navigationTitle("Site History")
        .inlineNavigationTitle()
    }

    private func content(_ presentation: SiteHistoryPresentation) -> some View {
        List {
            Section {
                Text(presentation.statusLine)
                    .accessibilityLabel(presentation.accessibilitySummary)
                if let action = presentation.action { actionButton(action) }
            }
            #if DEBUG
                if let debugActions { SiteHistoryDebugSection(actions: debugActions) }
            #endif
        }
    }

    @ViewBuilder private func actionButton(_ action: SiteHistoryPresentation.Action) -> some View {
        switch action {
        case .reconnectTesla:
            if let reconnectTesla {
                Button("Reconnect Tesla") { Task { await reconnectTesla.perform() } }
            }
        case .addLocation:
            NavigationLink("Add Location", value: SettingsDestination.solarForecast)
        case .useExactLocation:
            NavigationLink("Use My Exact Home Location", value: SettingsDestination.solarForecast)
        }
    }
}

/// The tab bar's accessory while history loads for a site without a usable layout.
@available(iOS 26.0, *)
struct SiteHistoryAccessory: View {
    let checkedDaysText: String
    let onOpen: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                if placement == .inline {
                    Text("Loading history · \(checkedDaysText)").font(.subheadline).lineLimit(1)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(SiteHistoryPresentation.title).font(.subheadline.weight(.semibold))
                        Text(checkedDaysText).font(.caption).foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(SiteHistoryPresentation.title), \(checkedDaysText)")
        .accessibilityHint("Opens Site History in Settings")
        .accessibilityAddTraits(.isButton)
    }
}

#if DEBUG
    #Preview("Site History · loading") {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = "2026-09-21"
        return NavigationStack {
            SiteHistoryView(
                status: SiteHistoryStatus(
                    scope: SolarForecastSiteScope(accountScopeID: "preview", siteID: "preview-home"),
                    progress: progress, throttledUntil: nil)
            )
        }
    }
#endif
