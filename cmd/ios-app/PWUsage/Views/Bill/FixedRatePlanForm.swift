import SwiftUI

/// Sheet for adding or editing the flat-rate reference plan used to compute savings.
struct FixedRatePlanForm: View {
    let existing: TariffPeriodDTO?
    let defaultStartDate: String?
    let suggestedStartDate: String?
    let timeZone: TimeZone
    let currency: String
    let onSave: (TariffPlanWriteRequest, TariffPeriodDTO?) async -> String?
    let onDelete: ((Int) async -> String?)?

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var buyRateText: String
    @State private var sellRateText: String
    @State private var startsOn: Date
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        existing: TariffPeriodDTO? = nil,
        defaultStartDate: String? = nil,
        suggestedStartDate: String? = nil,
        timeZone: TimeZone,
        currency: String,
        onSave: @escaping (TariffPlanWriteRequest, TariffPeriodDTO?) async -> String?,
        onDelete: ((Int) async -> String?)? = nil
    ) {
        self.existing = existing
        self.defaultStartDate = defaultStartDate
        self.suggestedStartDate = suggestedStartDate
        self.timeZone = timeZone
        self.currency = currency
        self.onSave = onSave
        self.onDelete = onDelete

        let window = existing?.seasons.first?.weekdayPeriods.first
        _name = State(initialValue: existing?.name ?? "Fixed Rate Plan")
        _buyRateText = State(initialValue: window.map { FixedRatePlanDraft.formatRate($0.buyRate) } ?? "")
        _sellRateText = State(
            initialValue: window.map { FixedRatePlanDraft.formatRate($0.sellRate) } ?? FixedRatePlanDraft.formatRate(0)
        )
        _startsOn = State(
            initialValue: Self.parseDate(existing?.effectiveFrom ?? defaultStartDate, timeZone: timeZone) ?? Date()
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                detailsSection
                ratesSection
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                if let existing, existing.source != .estimated, onDelete != nil {
                    deleteSection(periodID: existing.periodId)
                }
            }
            .navigationTitle(existing == nil ? "Add Fixed Rate Plan" : "Edit Fixed Rate Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }
                        .disabled(!canSave || isSaving)
                }
            }
        }
    }

    private var detailsSection: some View {
        Section {
            if existing?.source == .estimated {
                Text("Estimated")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            TextField("Plan name", text: $name)
                .textInputAutocapitalization(.words)
            RatePlanDateField(
                title: "Starts on", date: $startsOn,
                boundary: suggestedStartDate == nil ? .first : nil, timeZone: timeZone
            )
            if let suggestedStartDate,
               let date = Self.parseDate(suggestedStartDate, timeZone: timeZone),
               RatePlanTimelineFormatting.formatYMD(startsOn, in: timeZone) != suggestedStartDate {
                Button("Start on \(RatePlanTimelineFormatting.displayDate(suggestedStartDate))") { startsOn = date }
            }
        } footer: {
            Text("This is the flat rate you would pay without solar or your current rate plan.")
        }
    }

    private var ratesSection: some View {
        Section("Rates (\(currency) per kWh)") {
            HStack {
                Text("Price per kWh")
                Spacer()
                TextField("0.32", text: $buyRateText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 120)
            }
            HStack {
                Text("Export credit per kWh")
                Spacer()
                TextField("0.00", text: $sellRateText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 120)
            }
        }
    }

    private func deleteSection(periodID: Int) -> some View {
        Section {
            Button("Delete Fixed Rate Plan", role: .destructive) {
                Task { await deletePlan(periodID: periodID) }
            }
            .disabled(isSaving)
        }
    }

    private var parsedBuyRate: Double? {
        FixedRatePlanDraft.parseRate(buyRateText)
    }

    private var parsedSellRate: Double? {
        let trimmed = sellRateText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        return FixedRatePlanDraft.parseRate(trimmed)
    }

    private var canSave: Bool {
        parsedBuyRate != nil && parsedSellRate != nil
    }

    private func submit() async {
        guard let buyRate = parsedBuyRate, let sellRate = parsedSellRate else { return }
        isSaving = true
        errorMessage = nil
        let request = FixedRatePlanDraft.makeWriteRequest(
            name: name,
            buyRate: buyRate,
            sellRate: sellRate,
            startsOn: startsOn,
            timeZone: timeZone
        )
        let error = await onSave(request, existing)
        isSaving = false
        if let error {
            errorMessage = error
        } else {
            dismiss()
        }
    }

    private func deletePlan(periodID: Int) async {
        guard let onDelete else { return }
        isSaving = true
        errorMessage = nil
        let error = await onDelete(periodID)
        isSaving = false
        if let error {
            errorMessage = error
        } else {
            dismiss()
        }
    }

    private static func parseDate(_ raw: String?, timeZone: TimeZone) -> Date? {
        guard let raw else { return nil }
        let parts = raw.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

#Preview {
    FixedRatePlanForm(
        timeZone: TimeZone(identifier: "America/Los_Angeles") ?? .current,
        currency: "USD",
        onSave: { _, _ in nil }
    )
}
