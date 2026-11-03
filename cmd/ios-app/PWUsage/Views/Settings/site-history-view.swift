import SwiftUI

/// Site History in Settings: where loading history for Solar Forecasting stands for this site.
struct SiteHistoryView: View {
    let status: SiteHistoryStatus?
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
                VStack(alignment: .leading, spacing: 4) {
                    Text(presentation.headline).font(.body.weight(.semibold))
                    Text(presentation.detail).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
                if let action = presentation.action { actionButton(action) }
            }
            Section {
                LabeledContent("Days checked", value: presentation.checkedDays.formatted())
                LabeledContent("Days with data", value: presentation.daysWithData.formatted())
                if let producingDays = presentation.producingDays {
                    LabeledContent("Days with solar production", value: producingDays.formatted())
                }
                if let range = presentation.checkedRange {
                    LabeledContent("Checked", value: range)
                }
            } header: {
                Text("History")
            } footer: {
                Text("Newest days are checked first. A day without data is one Tesla has no record for, "
                    + "such as before your system was switched on.")
            }
        }
    }

    @ViewBuilder private func actionButton(_ action: SiteHistoryPresentation.Action) -> some View {
        switch action {
        case .reconnectTesla:
            if let reconnectTesla {
                Button("Reconnect Tesla") { Task { await reconnectTesla.perform() } }
            }
        case .setLocation:
            NavigationLink("Set Home Location", value: SettingsDestination.solarForecast)
        case .openSolarForecast:
            NavigationLink("Open Solar Forecast", value: SettingsDestination.solarForecast)
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
                        Text(SiteHistoryPresentation.accessoryTitle).font(.subheadline.weight(.semibold))
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
        .accessibilityLabel("\(SiteHistoryPresentation.accessoryTitle), \(checkedDaysText)")
        .accessibilityHint("Opens Site History in Settings")
        .accessibilityAddTraits(.isButton)
    }
}

#if DEBUG
    #Preview("Site History · loading") {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.oldestChecked = "2026-09-21"
        progress.daysWithData = 40
        progress.producingDays = 38
        return NavigationStack {
            SiteHistoryView(
                status: SiteHistoryStatus(
                    scope: SolarForecastSiteScope(accountScopeID: "preview", siteID: "preview-home"),
                    progress: progress, throttledUntil: nil, hasUsableLayout: false)
            )
        }
    }
#endif
