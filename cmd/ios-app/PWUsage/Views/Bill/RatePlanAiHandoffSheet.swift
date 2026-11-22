import PWUsageCore
import SwiftUI
#if canImport(UIKit)
    import UIKit
#endif

struct RatePlanAiHandoffSheet: View {
    enum Step: String, CaseIterable, Identifiable {
        case export = "1. Export"
        case `import` = "2. Import"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss
    @State private var model: RatePlanAiHandoffModel
    @State private var step: Step = .export
    @State private var copied = false

    let onApplied: (SiteTariffsTimelineResponse) -> Void

    init(actions: RatePlanAiHandoffActions, onApplied: @escaping (SiteTariffsTimelineResponse) -> Void) {
        _model = State(initialValue: RatePlanAiHandoffModel(actions: actions))
        self.onApplied = onApplied
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Step", selection: $step) {
                    ForEach(Step.allCases) { item in
                        Text(item.rawValue).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 10)

                if step == .export {
                    exportStepView
                } else {
                    importStepView
                }
            }
            .navigationTitle("Check with Your AI Assistant")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
                .task { await model.loadMarkdownIfNeeded() }
                .sheet(item: $model.presentedPreview) { preview in
                    RatePlanAiHandoffReviewSheet(model: model, preview: preview) { timeline in
                        onApplied(timeline)
                        dismiss()
                    }
                }
        }
    }

    private var exportStepView: some View {
        Form {
            Section {
                Text(
                    "Copy or share this Markdown prompt with your AI assistant. " +
                        "You can also attach a PDF or photo of your utility bill " +
                        "so it can check your exact all-in rates."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }

            exportActionsSection

            if let markdown = model.markdown {
                Section("Exported Prompt") {
                    Text(markdown)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(18)
                }
            }
        }
    }

    @ViewBuilder
    private var exportActionsSection: some View {
        Section {
            if model.isLoadingMarkdown {
                ProgressView("Preparing Markdown...")
            } else if let error = model.exportError {
                Text(error).foregroundStyle(.red)
                Button("Try Again") { Task { await model.reloadMarkdown() } }
            } else if let markdown = model.markdown {
                Button {
                    copyToClipboard(markdown)
                } label: {
                    Label(
                        copied ? "Copied to Clipboard" : "Copy Markdown",
                        systemImage: copied ? "checkmark" : "doc.on.doc"
                    )
                }
                .emphasisProminentButton()

                ShareLink(item: markdown) {
                    Label("Share Markdown", systemImage: "square.and.arrow.up")
                }

                Button("Next: Import AI Reply") {
                    step = .import
                }
            }
        }
    }

    private var importStepView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = model.reviewError {
                    AiHandoffBanner(message: error, tint: .red, systemImage: "exclamationmark.triangle.fill")
                }

                HStack {
                    Text("Paste AI Reply")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    #if canImport(UIKit)
                        Button {
                            if let pasted = UIPasteboard.general.string {
                                model.rawInput = pasted
                            }
                        } label: {
                            Label("Paste from Clipboard", systemImage: "doc.on.clipboard")
                                .font(.subheadline)
                        }
                    #endif
                }

                TextEditor(text: $model.rawInput)
                    .font(.system(.caption, design: .monospaced))
                    .frame(height: 180)
                    .padding(8)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(Color(.separator), lineWidth: 0.5)
                    )

                Text(
                    "Paste the assistant's full response or its ```json block. " +
                        "We'll validate it and open Review Changes before anything is saved."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding()
        }
        .background(SectionTheme.groupedBackground)
        .safeAreaInset(edge: .bottom) {
            importBottomBar
        }
    }

    private var importBottomBar: some View {
        VStack(spacing: 0) {
            Divider()
            ProminentActionButton(
                title: "Preview Changes", busyTitle: "Loading Preview…",
                isBusy: model.isPreviewing, isEnabled: model.canPreview
            ) {
                Task { await model.loadPreview() }
            }
            .controlSize(.large)
            .padding()
        }
        .background(.bar)
    }

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #endif
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

private struct RatePlanAiHandoffReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: RatePlanAiHandoffModel
    let preview: TariffAiHandoffPreviewResponse
    let onApplied: (SiteTariffsTimelineResponse) -> Void

    var body: some View {
        NavigationStack {
            Form {
                if model.isRefreshedAfterConflict {
                    Section {
                        Text(
                            "Your rate plans changed while you were reviewing. " +
                                "Review the updated changes before applying."
                        )
                        .foregroundStyle(.orange)
                    }
                }
                if let error = model.reviewError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
                notesAndSourcesSections
                changesSections
            }
            .navigationTitle("Review Changes")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    applyBottomBar
                }
        }
    }

    @ViewBuilder
    private var notesAndSourcesSections: some View {
        if !preview.notes.isEmpty {
            Section("Notes from Your AI Assistant") {
                ForEach(preview.notes, id: \.self) { note in
                    Text(note).font(.subheadline)
                }
            }
        }
        if !preview.sources.isEmpty {
            Section("Sources") {
                ForEach(preview.sources, id: \.self) { source in
                    Text(source).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var changesSections: some View {
        if !preview.hasChanges {
            Section {
                Text("No rate plan changes found · The imported plans match your current timeline.")
                    .foregroundStyle(.secondary)
            }
        } else {
            if !preview.actualPreviews.isEmpty {
                Section("Your Rate Plan Changes") {
                    ForEach(Array(preview.actualPreviews.enumerated()), id: \.offset) { _, item in
                        approximationNotesView(item.approximationNotes)
                        ForEach(Array(item.affectedIntervals.enumerated()), id: \.offset) { _, interval in
                            RatePlanReviewIntervalSection(interval: interval, currency: preview.currency)
                        }
                    }
                }
            }
            if !preview.referencePreviews.isEmpty {
                Section("Fixed Comparison Plan Changes") {
                    ForEach(Array(preview.referencePreviews.enumerated()), id: \.offset) { _, item in
                        approximationNotesView(item.approximationNotes)
                        ForEach(Array(item.affectedIntervals.enumerated()), id: \.offset) { _, interval in
                            RatePlanReviewIntervalSection(interval: interval, currency: preview.currency)
                        }
                    }
                }
            }
            confirmationSection
        }
    }

    @ViewBuilder
    private func approximationNotesView(_ notes: [TariffApproximationNote]) -> some View {
        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
            Label(note.message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    private var confirmationSection: some View {
        Section {
            if !preview.actualPreviews.isEmpty {
                Text(
                    "This changes the rates PWUsage uses for bills and savings estimates. " +
                        "Your Powerwall will continue using the plan saved in Tesla."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Toggle("I reviewed these changes", isOn: $model.isAcknowledged)
            Toggle("Verified against my utility bill", isOn: $model.isVerifiedAgainstBill)
        }
    }

    private var applyBottomBar: some View {
        VStack(spacing: 0) {
            Divider()
            ProminentActionButton(
                title: "Apply Changes", busyTitle: "Applying Changes…",
                isBusy: model.isApplying, isEnabled: model.canApply
            ) {
                Task {
                    if await model.apply(), let timeline = model.committedResponse?.timeline {
                        onApplied(timeline)
                    }
                }
            }
            .controlSize(.large)
            .padding()
        }
        .background(.bar)
    }
}

private struct AiHandoffBanner: View {
    let message: String
    let tint: Color
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
