import SwiftUI

/// What "How this is worked out" shows, captured when it is opened so later
/// refreshes don't change the sheet under the reader.
struct SmartShiftDetailsSnapshot: Identifiable {
    let id = UUID()
    let verdict: SmartShiftVerdict
    let comparison: LoadTimingForecastEstimator.Comparison?
    let rows: [PeriodRow]
    let breakdowns: [CostBreakdown]
    /// Why a cheaper start isn't suggested, when the safety rule turned one down.
    var ruledOutNote: String?
    /// Present only when the solar forecast priced this comparison.
    let forecastFetchedAt: Date?
    let contextAsOf: Date?
    let capturedAt: Date
    /// The pass's inputs and result, for "Copy diagnostics"; `nil` without a Job.
    var diagnostics: SmartShiftDiagnostics?
}

/// Rate periods, what the run draws from each bank, freshness and assumptions.
struct SmartShiftDetailsView: View {
    let snapshot: SmartShiftDetailsSnapshot
    /// Reads the forecast store's state when diagnostics are copied.
    var solarForecast: () async -> SmartShiftDiagnostics.SolarForecast? = { nil }

    @Environment(\.dismiss) private var dismiss
    @State private var copiedDiagnostics = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(snapshot.breakdowns.enumerated()), id: \.offset) { _, breakdown in
                    Section {
                        ForEach(Array(breakdown.lines.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(line.period).font(.body.weight(.semibold))
                                    Text(line.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(line.amount)
                                    .monospacedDigit()
                            }
                            .accessibilityElement(children: .combine)
                        }
                        HStack {
                            Text("Added to your bill").font(.body.weight(.semibold))
                            Spacer()
                            Text(breakdown.total)
                                .font(.body.weight(.bold))
                                .monospacedDigit()
                        }
                        .accessibilityElement(children: .combine)
                        ForEach(breakdown.notes, id: \.self) { note in
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text(breakdown.title)
                    }
                }
                if !snapshot.breakdowns.isEmpty {
                    Section {
                        if let solar = snapshot.comparison?.estimatedSolarContribution, solar > 0 {
                            Text("About \(solar.formatted(.number.precision(.fractionLength(1)))) kWh of this run could come from your solar.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } footer: {
                        Text("Energy from a bank costs only the export credit you give up. The rest is bought at the period's rate.")
                    }
                }
                if let ruledOut = snapshot.ruledOutNote {
                    Section {
                        Text(ruledOut)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Rate periods") {
                    ForEach(Array(snapshot.rows.enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.name).font(.body.weight(.semibold))
                                Text("Buy \(row.buy) · Sell \(row.sell)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(row.balance)
                                .font(.subheadline)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                if snapshot.forecastFetchedAt != nil || snapshot.contextAsOf != nil {
                    Section("Freshness") {
                        Text("Solar forecast · \(DashboardPresentation.freshness(snapshot.forecastFetchedAt, now: snapshot.capturedAt, staleAfter: 6 * 60 * 60))")
                        Text("Household pattern · \(DashboardPresentation.freshness(snapshot.contextAsOf, now: snapshot.capturedAt, staleAfter: 24 * 60 * 60))")
                    }
                    .font(.subheadline)
                }
                if let assumptions = snapshot.comparison?.assumptions, !assumptions.isEmpty {
                    Section("Assumptions") {
                        ForEach(assumptions, id: \.self) { assumption in
                            Text(assumption)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let diagnostics = snapshot.diagnostics {
                    Section {
                        Button {
                            Task {
                                var diagnostics = diagnostics
                                diagnostics.solarForecast = await solarForecast()
                                guard let json = try? diagnostics.json() else { return }
                                Clipboard.copy(json)
                                copiedDiagnostics = true
                            }
                        } label: {
                            Label(copiedDiagnostics ? "Copied" : "Copy diagnostics",
                                  systemImage: copiedDiagnostics ? "checkmark" : "doc.on.doc")
                        }
                    } footer: {
                        Text("Copies this comparison's inputs and result as JSON, for troubleshooting. It includes your site ID but no keys or passwords.")
                    }
                }
            }
            .navigationTitle("How This Is Worked Out")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
