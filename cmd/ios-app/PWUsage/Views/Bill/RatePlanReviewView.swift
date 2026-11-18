import SwiftUI

/// The server's before-and-after review of a rate plan change. Nothing is saved until the owner
/// acknowledges it and taps Apply; verifying against a bill is a separate, optional check.
struct RatePlanReviewView: View {
    @Bindable var model: RatePlanReviewModel
    let onApplied: (TariffSelectionCommitResponse) -> Void

    var body: some View {
        content
            .navigationTitle("Review Change")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .task {
                if case .loading = model.phase { await model.load() }
            }
            .onChange(of: model.phase) { _, phase in
                if case .applied(let response) = phase { onApplied(response) }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView("Preparing your review…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            EmptyStateScreen(
                symbol: "exclamationmark.triangle",
                title: "Couldn’t prepare the review",
                message: message,
                actionTitle: "Try Again"
            ) {
                Task { await model.load() }
            }
        case .reviewing(let preview), .applying(let preview):
            reviewForm(preview)
        case .applied:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func reviewForm(_ preview: TariffSelectionPreviewResponse) -> some View {
        Form {
            if model.isRefreshedAfterConflict {
                Section {
                    Label(RatePlanReviewPresentation.refreshedNotice, systemImage: "arrow.triangle.2.circlepath")
                        .font(.subheadline)
                }
            }
            RatePlanReviewSummarySection(preview: preview)
            ForEach(Array(preview.affectedIntervals.enumerated()), id: \.offset) { _, interval in
                RatePlanReviewIntervalSection(interval: interval, currency: preview.currency)
            }
            unchangedSection(preview)
            notesSection(preview)
            confirmationSection(preview)
        }
        .disabled(isApplying)
    }

    private var isApplying: Bool {
        if case .applying = model.phase { return true }
        return false
    }

    @ViewBuilder
    private func unchangedSection(_ preview: TariffSelectionPreviewResponse) -> some View {
        if !preview.unchangedOutsidePeriods.isEmpty {
            Section("Stays the Same") {
                ForEach(Array(preview.unchangedOutsidePeriods.enumerated()), id: \.offset) { _, period in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(period.plan.name)
                        Text(RatePlanReviewPresentation.rangeLabel(from: period.effectiveFrom, to: period.effectiveTo))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private func notesSection(_ preview: TariffSelectionPreviewResponse) -> some View {
        Section {
            Text(RatePlanReviewPresentation.recalculationNote(preview))
            if preview.holidaysUseWeekendSchedule {
                Text("Holidays use the weekend schedule.")
            }
            ForEach(Array(preview.approximationNotes.enumerated()), id: \.offset) { _, note in
                Label(note.message, systemImage: "info.circle")
            }
            Text(preview.scope == .actual
                ? RatePlanReviewPresentation.powerwallWarning
                : RatePlanReviewPresentation.referenceNote)
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
    }

    private func confirmationSection(_ preview: TariffSelectionPreviewResponse) -> some View {
        Section {
            Toggle(RatePlanReviewPresentation.acknowledgementLabel, isOn: $model.isAcknowledged)
            Toggle(RatePlanReviewPresentation.verificationLabel, isOn: $model.isVerifiedAgainstBill)
            Button {
                Task { await model.apply() }
            } label: {
                HStack {
                    Text("Apply Change")
                        .fontWeight(.semibold)
                    if isApplying {
                        Spacer()
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(!model.canApply)
        } footer: {
            confirmationFooter(preview)
        }
    }

    @ViewBuilder
    private func confirmationFooter(_ preview: TariffSelectionPreviewResponse) -> some View {
        if let applyError = model.applyError {
            Text(applyError).foregroundStyle(.red)
        } else if model.isRestoration, !preview.restoration.canApplyRestoration {
            Text("There’s no saved Tesla plan to restore for these dates.")
        } else {
            Text("Applying saves this change in PWUsage only.")
        }
    }
}

/// What changes, on which dates, and to which plan.
private struct RatePlanReviewSummarySection: View {
    let preview: TariffSelectionPreviewResponse

    var body: some View {
        Section {
            LabeledContent("Dates", value: RatePlanReviewPresentation.rangeLabel(
                from: preview.effectiveFrom, to: preview.effectiveTo
            ))
            LabeledContent("Plan", value: preview.scope == .actual ? "Your rate plan" : "Fixed comparison plan")
            if let candidate = preview.candidatePlan {
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.name).font(.headline)
                    Text(RatePlanSourcePresentation.sourceLabel(candidate.source))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let revisionStart = candidate.revisionStart {
                        Text("Published rates since \(RatePlanTimelineFormatting.displayDate(revisionStart))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Change")
        } footer: {
            Text("Rates are per \(preview.unit) in \(preview.currency), on your site’s calendar.")
        }
    }
}
