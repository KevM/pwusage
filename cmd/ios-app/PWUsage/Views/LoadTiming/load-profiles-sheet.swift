import SwiftUI
import UIKit

struct LoadProfilesSheet: View {
    @ObservedObject var store: LoadProfileStore
    @Environment(\.dismiss) var dismiss
    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    @State var draft: ProfileDraft?
    @State var pendingDeletion: LoadProfile?
    @State var pendingReset: LoadProfile?
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
                        draft = ProfileDraft.newCustom()
                    } label: {
                        Label("Add a Custom Job", systemImage: "plus.circle.fill")
                    }
                    .accessibilityHint("Creates a named job with energy and duration settings")
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
            .sheet(item: $draft) { value in
                ProfileEditorSheet(
                    draft: value,
                    onCancel: { draft = nil },
                    onSave: save
                )
            }
            .confirmationDialog(
                "Delete \(pendingDeletion?.name ?? "custom job")?",
                isPresented: Binding(
                    get: { pendingDeletion != nil },
                    set: { if !$0 { pendingDeletion = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Custom Job", role: .destructive) {
                    guard let profile = pendingDeletion else { return }
                    do {
                        try store.deleteCustomProfile(id: profile.id)
                        pendingDeletion = nil
                    } catch {
                        validationMessage = message(for: error)
                    }
                }
                Button("Cancel", role: .cancel) { pendingDeletion = nil }
            } message: {
                Text("This removes the job from this device.")
            }
            .confirmationDialog(
                "Reset \(pendingReset?.name ?? "profile") to its default settings?",
                isPresented: Binding(
                    get: { pendingReset != nil },
                    set: { if !$0 { pendingReset = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Reset to Defaults", role: .destructive) {
                    guard let profile = pendingReset else { return }
                    do {
                        try store.resetBuiltInProfile(id: profile.id)
                        pendingReset = nil
                    } catch {
                        validationMessage = message(for: error)
                    }
                }
                Button("Cancel", role: .cancel) { pendingReset = nil }
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
                if profile.kind == .custom {
                    Button("Delete", role: .destructive) { pendingDeletion = profile }
                } else {
                    Button("Reset to Defaults", role: .destructive) { pendingReset = profile }
                }
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
            validationMessage = draft.kind == .custom && draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Enter a name for this custom job."
                : "Energy and duration must be greater than zero. Check the car charge settings too."
            return
        }
        do {
            let saved: LoadProfile
            if let id = draft.id {
                saved = try store.editProfile(
                    id: id,
                    name: draft.kind == .custom ? draft.name : nil,
                    energyKwh: draft.energyKwh,
                    durationHours: draft.durationHours,
                    carSettings: draft.carSettings
                )
            } else {
                saved = try store.createCustomProfile(name: draft.name, energyKwh: draft.energyKwh, durationHours: draft.durationHours)
            }
            try store.selectProfile(id: saved.id)
            self.draft = nil
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
            return "\(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh · \(profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hr"
        }
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) else { return "Car estimate unavailable" }
        return "\(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh to add · about \(estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hr"
    }

    func profileAccessibilitySummary(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let car = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) {
            return "\(profile.name), \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours to add, about \(estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours at Level \(car.chargingLevel == .level1 ? "1" : "2")"
        }
        return "\(profile.name), \(profile.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kilowatt-hours, \(profile.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours"
    }
}
