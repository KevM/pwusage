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
        Form {
            importInputSection
            if let error = model.reviewError {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
            if model.isRefreshedAfterConflict {
                Section {
                    Text(
                        "Your rate plans changed while you were reviewing. Review the updated changes before applying."
                    )
                    .foregroundStyle(.orange)
                }
            }
            if let preview = model.preview {
                previewSections(preview)
            }
        }
    }

    private var importInputSection: some View {
        Section("Paste AI Reply") {
            #if canImport(UIKit)
                Button {
                    if let pasted = UIPasteboard.general.string {
                        model.rawInput = pasted
                    }
                } label: {
                    Label("Paste from Clipboard", systemImage: "doc.on.clipboard")
                }
            #endif

            TextEditor(text: $model.rawInput)
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: 140)

            Button {
                Task { await model.loadPreview() }
            } label: {
                if model.isPreviewing {
                    ProgressView()
                } else {
                    Text("Preview Changes")
                }
            }
            .disabled(!model.canPreview)
        }
    }

    @ViewBuilder
    private func previewSections(_ preview: TariffAiHandoffPreviewResponse) -> some View {
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
        if !preview.hasChanges {
            Section {
                Text("No rate plan changes found · The imported plans match your current timeline.")
                    .foregroundStyle(.secondary)
            }
        } else {
            previewChangeSections(preview)
            confirmationSection(preview)
        }
    }

    @ViewBuilder
    private func previewChangeSections(_ preview: TariffAiHandoffPreviewResponse) -> some View {
        if !preview.actualPreviews.isEmpty {
            Section("Your Rate Plan Changes") {
                ForEach(Array(preview.actualPreviews.enumerated()), id: \.offset) { _, item in
                    ForEach(Array(item.affectedIntervals.enumerated()), id: \.offset) { _, interval in
                        RatePlanReviewIntervalSection(interval: interval, currency: preview.currency)
                    }
                }
            }
        }
        if !preview.referencePreviews.isEmpty {
            Section("Fixed Comparison Plan Changes") {
                ForEach(Array(preview.referencePreviews.enumerated()), id: \.offset) { _, item in
                    ForEach(Array(item.affectedIntervals.enumerated()), id: \.offset) { _, interval in
                        RatePlanReviewIntervalSection(interval: interval, currency: preview.currency)
                    }
                }
            }
        }
    }

    private func confirmationSection(_ preview: TariffAiHandoffPreviewResponse) -> some View {
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
            Toggle("I checked these details against my utility bill", isOn: $model.isVerifiedAgainstBill)
            Button {
                Task {
                    if await model.apply(), let timeline = model.committedResponse?.timeline {
                        onApplied(timeline)
                        dismiss()
                    }
                }
            } label: {
                if model.isApplying {
                    ProgressView()
                } else {
                    Text("Apply Rate Plan Changes")
                        .frame(maxWidth: .infinity)
                }
            }
            .emphasisProminentButton()
            .disabled(!model.canApply)
        }
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
