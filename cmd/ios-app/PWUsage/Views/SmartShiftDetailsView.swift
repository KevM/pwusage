import SwiftUI

/// What "How this is worked out" shows, captured when it is opened so later
/// refreshes don't change the sheet under the reader.
struct SmartShiftDetailsSnapshot: Identifiable {
    let id = UUID()
    let verdict: SmartShiftVerdict
    let comparison: LoadTimingForecastEstimator.Comparison?
    let rows: [PeriodRow]
    let runRows: [RunRow]
    /// Present only when the solar forecast priced this comparison.
    let forecastFetchedAt: Date?
    let contextAsOf: Date?
    let capturedAt: Date
}

/// Rate periods, what the run draws from each bank, freshness and assumptions.
struct SmartShiftDetailsView: View {
    let snapshot: SmartShiftDetailsSnapshot

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
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
                if !snapshot.runRows.isEmpty {
                    Section {
                        ForEach(Array(snapshot.runRows.enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.name).font(.body.weight(.semibold))
                                Text("\(row.fromBank) · \(row.bought)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                        if let solar = snapshot.comparison?.estimatedSolarContribution, solar > 0 {
                            Text("About \(solar.formatted(.number.precision(.fractionLength(1)))) kWh of this run could come from your solar.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("This run")
                    } footer: {
                        Text("Energy from a bank costs only the credit you give up. The rest is bought at the full rate.")
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
