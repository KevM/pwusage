import SwiftUI

/// Picks the day of the month a bill starts and saves it. Shared by the Settings row and the
/// first-run prompt, so both save the same way and fail the same way.
struct BillingDayForm: View {
    var title: String?
    var message: String?
    let buttonTitle: String
    let save: (Int) async throws -> Void
    var onSaved: () -> Void = {}

    @State private var day: Int
    @State private var isSaving = false
    @State private var saveFailed = false

    init(
        initialDay: Int, title: String? = nil, message: String? = nil, buttonTitle: String,
        save: @escaping (Int) async throws -> Void, onSaved: @escaping () -> Void = {}
    ) {
        _day = State(initialValue: BillingDayPresentation.days.contains(initialDay) ? initialDay : 1)
        self.title = title
        self.message = message
        self.buttonTitle = buttonTitle
        self.save = save
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            if title != nil || message != nil {
                Section { intro }
            }
            Section {
                Picker(BillingDayPresentation.settingTitle, selection: $day) {
                    ForEach(BillingDayPresentation.days, id: \.self) { Text("\($0)").tag($0) }
                }
                .pickerStyle(.wheel)
                .disabled(isSaving)
            } footer: {
                Text(BillingDayPresentation.footer)
            }
            Section {
                Button(action: submit) {
                    HStack {
                        Text(buttonTitle)
                        if isSaving { ProgressView() }
                    }
                    .frame(maxWidth: .infinity)
                }
                .emphasisProminentButton()
                .disabled(isSaving)
                .accessibilityIdentifier("billing-day.save")
                if saveFailed {
                    Label(BillingDayPresentation.saveFailure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.title3.weight(.semibold)) }
            if let message { Text(message).font(.subheadline).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }

    private func submit() {
        guard !isSaving else { return }
        isSaving = true
        saveFailed = false
        Task {
            do {
                try await save(day)
                onSaved()
            } catch {
                saveFailed = true
            }
            isSaving = false
        }
    }
}

/// Settings > Bill start day.
struct BillingDaySettingsView: View {
    let site: MobileSite
    let save: (Int) async throws -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        BillingDayForm(
            initialDay: site.billingDay, buttonTitle: "Save", save: save, onSaved: { dismiss() })
            .navigationTitle(BillingDayPresentation.settingTitle)
            .inlineNavigationTitle()
    }
}

/// Shown once for a site nobody has chosen a billing day for. Not now, or a swipe down, puts it off
/// until the next launch.
struct BillingDayPromptSheet: View {
    let site: MobileSite
    let save: (Int) async throws -> Void
    let onNotNow: () -> Void

    var body: some View {
        NavigationStack {
            BillingDayForm(
                initialDay: site.billingDay,
                title: BillingDayPresentation.promptTitle,
                message: BillingDayPresentation.promptMessage,
                buttonTitle: "Confirm",
                save: save
            )
            .navigationTitle(site.name)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now", action: onNotNow) }
            }
        }
    }
}
