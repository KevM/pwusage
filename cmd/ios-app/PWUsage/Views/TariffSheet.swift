import SwiftUI

/// The Rate Plans page. Pushed from Settings, so it has no stack or Done button
/// of its own; the host supplies those.
struct TariffSheet: View {
    let site: MobileSite
    let load: @MainActor () async throws -> MobileTariffsResponse
    @Environment(\.scenePhase) private var scenePhase
    @State private var response: MobileTariffsResponse?
    @State private var isLoading = false
    @State private var failed = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            List {
                if let response {
                    Section("Currently active") {
                        if let summary = response.activeSummary(now: context.date), !failed {
                            Label(summary, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Text(failed ? "Current activity unavailable" : response.activityIsCurrent(now: context.date) ? "No period matches the current time." : "Updating current activity…")
                                .foregroundStyle(.secondary)
                        }
                        Text("Times shown in \(response.site.timezone)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(response.tariffs) { tariff in
                        if tariff.seasons.isEmpty {
                            Section(tariff.name) { Text("No seasons defined.").foregroundStyle(.secondary) }
                        }
                        ForEach(tariff.seasons) { season in
                            Section {
                                if season.periods.isEmpty {
                                    Text("No periods defined.").foregroundStyle(.secondary)
                                }
                                ForEach(season.periods) { period in
                                    periodRow(period, currency: response.currency,
                                              active: period.isActive && !failed && response.activityIsCurrent(now: context.date))
                                }
                            } header: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(tariff.name)
                                    Text(season.name + (season.isActive && !failed && response.activityIsCurrent(now: context.date) ? " · Active season" : ""))
                                        .font(.headline)
                                    Text(season.dates)
                                }
                            }
                        }
                    }
                    if response.tariffs.isEmpty {
                        ContentUnavailableView("No tariffs", systemImage: "tag", description: Text("No tariffs are configured for this site."))
                    }
                } else if isLoading {
                    HStack { Spacer(); ProgressView("Loading tariffs…"); Spacer() }
                }
                if failed {
                    Section {
                        Text(response == nil ? "Tariffs could not be loaded." : "Showing previously loaded rates. Current activity could not be refreshed.")
                            .foregroundStyle(.secondary)
                        Button("Retry") { Task { await refresh() } }.disabled(isLoading)
                    }
                }
                Section {
                    Text("Rates are saved from your Powerwall settings in the Tesla app. Holiday overrides are included when determining the active period.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Rate Plans")
            .inlineNavigationTitle()
            .refreshable { await refresh() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await refresh()
                while !Task.isCancelled {
                    // Refresh at minute boundaries, when tariff activity can change.
                    let seconds = 60 - Date.now.timeIntervalSince1970.truncatingRemainder(dividingBy: 60)
                    do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                    await refresh()
                }
            }
        }
    }

    private func periodRow(_ period: MobileTariffsResponse.Period, currency: String, active: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(period.name).font(.headline)
                if active {
                    Label("Active", systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold)).foregroundStyle(.green)
                }
            }
            Text("\(period.days) · \(period.times)").font(.subheadline).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) { rates(period, currency: currency) }
                VStack(alignment: .leading, spacing: 4) { rates(period, currency: currency) }
            }
            .font(.subheadline).monospacedDigit()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func rates(_ period: MobileTariffsResponse.Period, currency: String) -> some View {
        Text("Buy \(rate(period.buyRate, currency: currency))/kWh")
        Text("Sell \(rate(period.sellRate, currency: currency))/kWh")
    }

    private func rate(_ value: Double?, currency: String) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.currency(code: currency).precision(.fractionLength(4)))
    }

    @MainActor private func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await load().validating(siteID: site.id)
            guard !Task.isCancelled else { return }
            response = result
            failed = false
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }
}

#Preview("Rate Plans · Empty") {
    NavigationStack {
        TariffSheet(site: MobileSite(id: "preview", name: "Home", utility: "Utility"), load: {
            MobileTariffsResponse(version: 1, site: .init(id: "preview", name: "Home", timezone: "America/Chicago"), currency: "USD", asOf: .now, tariffs: [])
        })
    }
}

#Preview("Rate Plans · Seasons and periods") {
    NavigationStack { TariffSheet(site: MobileSite(id: "preview", name: "Home", utility: "Utility"), load: {
        MobileTariffsResponse(
            version: 1, site: .init(id: "preview", name: "Home", timezone: "America/Chicago"),
            currency: "USD", asOf: .now,
            tariffs: [.init(id: 1, name: "Residential", seasons: [
                .init(id: 2, name: "Winter", dates: "Oct 1 – Apr 30", isActive: true, periods: [
                    .init(id: 3, name: "Peak", days: "Mon – Fri", times: "08:00 – 20:00", buyRate: 0.30, sellRate: 0.10, isActive: true),
                    .init(id: 4, name: "Off peak", days: "Mon – Fri", times: "20:00 – 08:00", buyRate: 0.15, sellRate: 0.08, isActive: false),
                    .init(id: 5, name: "Weekend", days: "Sat – Sun", times: "All Day", buyRate: 0.15, sellRate: 0.08, isActive: false),
                ]),
                .init(id: 6, name: "Summer", dates: "May 1 – Sep 30", isActive: false, periods: [
                    .init(id: 7, name: "Standard", days: "Every day", times: "All Day", buyRate: 0.25, sellRate: 0.10, isActive: false),
                ]),
            ])]
        )
    }) }
}
