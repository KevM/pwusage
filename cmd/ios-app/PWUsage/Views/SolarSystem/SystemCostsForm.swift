import SwiftUI

/// The System Costs inputs. Pure: the sheet binds to it and saves `request` when it is non-nil.
struct SystemCostsDraft: Equatable {
    struct Component: Equatable {
        /// YYYY-MM-DD the component was installed. A nil solar day means the site's install day applies.
        var installDay: String?
        var price: Double?
        var incentives: Double?
        /// Percent of the net price claimed back; nil when the credit is off.
        private(set) var taxCreditPercent: Double?
        /// Once the owner edits the credit, install date changes stop re-applying the default.
        private(set) var isCreditEdited: Bool

        /// The fallback credit when no install year is known, and when the owner switches a credit on after it ended.
        static let fallbackCreditPercent = 30.0

        init(dto: SystemCostDTO?, fallbackDay: String?) {
            installDay = dto?.installDate ?? fallbackDay
            price = dto?.price
            incentives = dto?.incentives
            if let dto {
                taxCreditPercent = dto.taxCreditPercent
                isCreditEdited = true
            } else {
                taxCreditPercent = Self.defaultCredit(forDay: installDay)
                isCreditEdited = false
            }
        }

        mutating func setInstallDay(_ day: String?) {
            installDay = day
            if !isCreditEdited {
                taxCreditPercent = Self.defaultCredit(forDay: day)
            }
        }

        mutating func setTaxCredit(_ percent: Double?) {
            taxCreditPercent = percent
            isCreditEdited = true
        }

        mutating func setTaxCreditOn(_ isOn: Bool) {
            setTaxCredit(isOn ? (taxCreditPercent ?? Self.fallbackCreditPercent) : nil)
        }

        /// The saved shape of this component, or nil when it has no price.
        var dto: SystemCostDTO? {
            guard let price else { return nil }
            return SystemCostDTO(
                installDate: installDay,
                price: price,
                taxCreditPercent: taxCreditPercent,
                incentives: incentives ?? 0
            )
        }

        /// Incentives may not exceed the price. A cleared price drops the component, so its incentives don't count.
        var isIncentiveValid: Bool {
            guard let price else { return true }
            return (incentives ?? 0) <= price
        }

        /// Price less incentives and the credit. Nil without a valid price.
        var netCost: Double? {
            guard isIncentiveValid, let dto else { return nil }
            return PaybackCalculator.netCost(dto)
        }

        private static func defaultCredit(forDay day: String?) -> Double? {
            let year = day.flatMap { Int($0.prefix(4)) }
                ?? Calendar(identifier: .gregorian).component(.year, from: Date())
            return PaybackCalculator.defaultTaxCreditPercent(installYear: year)
        }
    }

    let timeZone: TimeZone
    let hasPowerwall: Bool
    var solar: Component
    var powerwall: Component

    init(costs: SystemCostsDTO?, batteryStartDay: String?, hasPowerwall: Bool, timeZone: TimeZone) {
        self.timeZone = timeZone
        self.hasPowerwall = hasPowerwall
        solar = Component(dto: costs?.solar, fallbackDay: costs?.siteInstalled)
        powerwall = Component(dto: costs?.powerwall, fallbackDay: batteryStartDay)
    }

    var solarNetCost: Double? { solar.netCost }

    var powerwallNetCost: Double? {
        hasPowerwall ? powerwall.netCost : nil
    }

    /// The first problem that blocks saving, or nil when the entries are valid.
    var validationMessage: String? {
        if !solar.isIncentiveValid || (hasPowerwall && !powerwall.isIncentiveValid) {
            return "Rebates and incentives can’t be more than the price."
        }
        if hasPowerwall, powerwall.price != nil, powerwall.installDay == nil {
            return "Enter when the Powerwall was installed."
        }
        return nil
    }

    /// The payload to save, or nil while an entry is invalid. A cleared component is sent as nil.
    var request: SystemCostsWriteRequest? {
        guard validationMessage == nil else { return nil }
        return SystemCostsWriteRequest(solar: solar.dto, powerwall: hasPowerwall ? powerwall.dto : nil)
    }
}

/// Sheet that edits the site's solar and Powerwall costs, which drive the Payback section.
struct SystemCostsForm: View {
    let currency: String
    let onSave: (SystemCostsWriteRequest) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: SystemCostsDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        costs: SystemCostsDTO?,
        batteryStartDay: String?,
        hasPowerwall: Bool,
        timeZone: TimeZone,
        currency: String,
        onSave: @escaping (SystemCostsWriteRequest) async -> String?
    ) {
        self.currency = currency
        self.onSave = onSave
        _draft = State(initialValue: SystemCostsDraft(
            costs: costs, batteryStartDay: batteryStartDay, hasPowerwall: hasPowerwall, timeZone: timeZone
        ))
    }

    var body: some View {
        NavigationStack {
            Form {
                CostComponentSection(
                    title: "Solar",
                    component: $draft.solar,
                    timeZone: draft.timeZone,
                    currency: currency,
                    footer: draft.hasPowerwall ? nil : Self.footer
                )
                if draft.hasPowerwall {
                    CostComponentSection(
                        title: "Powerwall",
                        component: $draft.powerwall,
                        timeZone: draft.timeZone,
                        currency: currency,
                        footer: Self.footer
                    )
                }
                if let message = errorMessage ?? draft.validationMessage {
                    Section {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("System Costs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }
                        .disabled(draft.request == nil || isSaving)
                }
            }
        }
    }

    private static let footer = "Paying off a loan? Enter the total you’ll pay over the loan as the price. "
        + "The tax credit is counted on the price after rebates. Everyone on this site sees these costs."

    private func submit() async {
        guard let request = draft.request else { return }
        isSaving = true
        errorMessage = nil
        let error = await onSave(request)
        isSaving = false
        if let error {
            errorMessage = error
        } else {
            dismiss()
        }
    }
}

/// One component's rows: install day, price, credit, incentives and the net cost.
private struct CostComponentSection: View {
    let title: String
    @Binding var component: SystemCostsDraft.Component
    let timeZone: TimeZone
    let currency: String
    let footer: String?

    private var latestDay: Date {
        let today = RatePlanTimelineFormatting.formatYMD(Date(), in: timeZone)
        return RatePlanTimelineFormatting.parseYMD(today, in: timeZone) ?? Date()
    }

    var body: some View {
        Section {
            installRow
            amountRow("Price", value: $component.price)
            Toggle("Federal Tax Credit", isOn: Binding(
                get: { component.taxCreditPercent != nil },
                set: { component.setTaxCreditOn($0) }
            ))
            if component.taxCreditPercent != nil {
                HStack {
                    Text("Credit Rate")
                    Spacer()
                    TextField("30", value: Binding(
                        get: { component.taxCreditPercent ?? 0 },
                        set: { component.setTaxCredit($0) }
                    ), format: .number.precision(.fractionLength(0 ... 2)))
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 120)
                    Text("%")
                        .foregroundStyle(.secondary)
                }
            }
            amountRow("Rebates and Incentives", value: $component.incentives)
            if let netCost = component.netCost {
                LabeledContent("Net Cost", value: SavingsPresentation.aboutAmount(netCost, currency: currency))
            }
        } header: {
            Text(title)
        } footer: {
            if let footer {
                Text(footer)
            }
        }
    }

    @ViewBuilder private var installRow: some View {
        if let day = component.installDay {
            DatePicker("Installed", selection: installDate(day), in: ...latestDay, displayedComponents: .date)
                .environment(\.calendar, calendar)
                .environment(\.timeZone, timeZone)
        } else {
            Button("Set Install Date") { component.setInstallDay(today) }
        }
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private var today: String {
        RatePlanTimelineFormatting.formatYMD(Date(), in: timeZone)
    }

    private func installDate(_ day: String) -> Binding<Date> {
        Binding(
            get: { RatePlanTimelineFormatting.parseYMD(day, in: timeZone) ?? latestDay },
            set: { component.setInstallDay(RatePlanTimelineFormatting.formatYMD($0, in: timeZone)) }
        )
    }

    private func amountRow(_ label: LocalizedStringKey, value: Binding<Double?>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField(
                "0",
                value: value,
                format: .currency(code: currency).precision(.fractionLength(0 ... 2))
            )
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 140)
        }
    }
}

#Preview {
    SystemCostsForm(
        costs: nil,
        batteryStartDay: "2024-03-04",
        hasPowerwall: true,
        timeZone: TimeZone(identifier: "America/Los_Angeles") ?? .current,
        currency: "USD",
        onSave: { _ in nil }
    )
}
