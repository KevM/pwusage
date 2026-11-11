import SwiftUI
import UIKit

struct LoadProfilesSheet: View {
    @ObservedObject var store: LoadProfileStore
    @Environment(\.dismiss) var dismiss
    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    @State var draft: ProfileDraft?
    @State var isChoosingTemplate = false
    @State var pendingDeletion: LoadProfile?
    @State var validationMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Jobs") {
                    ForEach(store.profiles) { profile in
                        profileRow(profile)
                    }
                    .onMove { offsets, destination in
                        store.moveProfiles(fromOffsets: offsets, toOffset: destination)
                    }
                    Button {
                        isChoosingTemplate = true
                    } label: {
                        Label("Add a Job", systemImage: "plus.circle.fill")
                    }
                    .accessibilityHint("Starts from a template such as a car, dishwasher or custom job")
                }

                Section {
                    Text("Reordering jobs applies immediately. Edits take effect when you save.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(isPresented: $isChoosingTemplate) {
                JobTemplatePicker { template in
                    isChoosingTemplate = false
                    draft = template
                }
            }
            .sheet(item: $draft) { value in
                ProfileEditorSheet(
                    draft: value,
                    onCancel: { draft = nil },
                    onSave: save
                )
            }
            .confirmationDialog(
                "Delete \(pendingDeletion?.name ?? "this job")?",
                isPresented: Binding(
                    get: { pendingDeletion != nil },
                    set: { if !$0 { pendingDeletion = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Job", role: .destructive) {
                    guard let profile = pendingDeletion else { return }
                    do {
                        try store.deleteProfile(id: profile.id)
                        pendingDeletion = nil
                    } catch {
                        validationMessage = message(for: error)
                    }
                }
                Button("Cancel", role: .cancel) { pendingDeletion = nil }
            } message: {
                Text("This removes the job from this device.")
            }
            .alert("Couldn’t update jobs", isPresented: Binding(
                get: { validationMessage != nil },
                set: { if !$0 { validationMessage = nil } }
            )) {
                Button("OK", role: .cancel) { validationMessage = nil }
            } message: {
                Text(validationMessage ?? "Check the job settings and try again.")
            }
        }
    }

    @ViewBuilder
    func profileRow(_ profile: LoadProfile) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                draft = ProfileDraft(profile: profile)
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: JobGlyphs.symbol(for: profile))
                        .foregroundStyle(.tint)
                        .frame(width: 28, height: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(profile.name)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(profileSummary(profile))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(profileAccessibilitySummary(profile))
            .accessibilityHint("Edit this job’s settings")

            Menu {
                Button("Edit") { draft = ProfileDraft(profile: profile) }
                Button("Duplicate") { duplicate(profile) }
                Button("Delete", role: .destructive) { pendingDeletion = profile }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Actions for \(profile.name)")
        }
        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 5 : 1)
    }

    func save(_ draft: ProfileDraft) {
        guard draft.isValid else {
            validationMessage = draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Enter a name for this job."
                : "Energy and duration must be greater than zero. Check the car charge settings too."
            return
        }
        do {
            let saved: LoadProfile
            if let id = draft.id {
                saved = try store.editProfile(id: id, edit: ProfileEdit(
                    name: draft.name, energyKwh: draft.energyKwh, durationHours: draft.durationHours,
                    carSettings: draft.carSettings, size: draft.size, actionVerb: draft.actionVerb,
                    symbol: draft.symbol, updatesSize: draft.kind == .custom))
            } else if draft.kind == .car, let settings = draft.carSettings {
                saved = try store.createCarProfile(name: draft.name, settings: settings, symbol: draft.symbol)
            } else {
                saved = try store.addProfile(draft.newProfile)
            }
            try store.selectProfile(id: saved.id)
            self.draft = nil
        } catch {
            validationMessage = message(for: error)
        }
    }

    func duplicate(_ profile: LoadProfile) {
        do {
            try store.duplicateProfile(id: profile.id)
        } catch {
            validationMessage = message(for: error)
        }
    }

    /// Surfaces the store's own reason for the failure, so a new `LoadProfileError`
    /// case explains itself instead of falling back to a generic string.
    func message(for error: Error) -> String {
        if let loadProfileError = error as? LoadProfileError,
           let description = loadProfileError.errorDescription {
            return description
        }
        return "Check the job settings and try again."
    }

    func profileSummary(_ profile: LoadProfile) -> String {
        guard profile.kind == .car, let car = profile.carSettings else {
            let energy = profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
            let duration = profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
            return "\(energy) kWh · \(duration) hr"
        }
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) else {
            return "Car estimate unavailable"
        }
        let batteryKwh = estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
        let durationHours = estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
        return "\(batteryKwh) kWh to add · about \(durationHours) hr"
    }

    func profileAccessibilitySummary(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let car = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) {
            let batteryKwh = estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
            let durationHours = estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
            return "\(profile.name), \(batteryKwh) kilowatt-hours to add, about \(durationHours) hours at Level "
                + "\(car.chargingLevel == .level1 ? "1" : "2")"
        }
        let energyKwh = profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
        let durationHours = profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
        return "\(profile.name), \(energyKwh) kilowatt-hours, \(durationHours) hours"
    }
}
