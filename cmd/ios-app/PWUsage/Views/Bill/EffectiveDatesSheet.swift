import SwiftUI

struct EffectiveDatesSheet: View {
    let period: TariffPeriodDTO
    let onSave: (Int, TariffPlanPatchRequest) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var startDate: Date
    @State private var isOngoing: Bool
    @State private var endDate: Date
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(
        period: TariffPeriodDTO,
        onSave: @escaping (Int, TariffPlanPatchRequest) async throws -> Void
    ) {
        self.period = period
        self.onSave = onSave
        let initialStart = Self.pickerDate(fromYMD: period.effectiveFrom) ?? Date()
        let initialEnd = period.effectiveTo.flatMap(Self.pickerDate(fromYMD:)) ?? initialStart
        _startDate = State(initialValue: initialStart)
        _isOngoing = State(initialValue: period.effectiveTo == nil)
        _endDate = State(initialValue: initialEnd)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(period.name).font(.headline)
                    DatePicker("Effective From", selection: $startDate, displayedComponents: .date)
                    Toggle("Ongoing (no end date)", isOn: $isOngoing)
                    if !isOngoing {
                        DatePicker("Effective To", selection: $endDate, displayedComponents: .date)
                    }
                } footer: {
                    Text("Historical energy days in this range will recalculate after saving.")
                }

                if let validationError {
                    Section {
                        Text(validationError).foregroundStyle(.red).font(.caption)
                    }
                } else if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red).font(.caption)
                    }
                }
            }
            .navigationTitle("Effective Dates")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(isSaving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isSaving ? "Saving..." : "Save") { save() }
                            .disabled(isSaving || validationError != nil)
                    }
                }
        }
    }

    private var validationError: String? {
        let fromYMD = Self.ymd(fromPickerDate: startDate)
        if !isOngoing {
            let toYMD = Self.ymd(fromPickerDate: endDate)
            if toYMD < fromYMD {
                return "Effective To must be on or after Effective From."
            }
        }
        return nil
    }

    private func save() {
        guard validationError == nil else { return }
        errorMessage = nil
        isSaving = true
        let patch = TariffPlanPatchRequest(
            effectiveFrom: Self.ymd(fromPickerDate: startDate),
            effectiveTo: .set(isOngoing ? nil : Self.ymd(fromPickerDate: endDate))
        )
        Task {
            do {
                try await onSave(period.periodId, patch)
                await MainActor.run {
                    isSaving = false
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private static func pickerDate(fromYMD ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let comps = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        return Calendar.current.date(from: comps)
    }

    private static func ymd(fromPickerDate date: Date) -> String {
        RatePlanTimelineFormatting.formatYMD(date, in: Calendar.current.timeZone)
    }
}
