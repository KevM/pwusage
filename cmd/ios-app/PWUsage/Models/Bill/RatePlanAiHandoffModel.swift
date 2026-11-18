import Foundation
import Observation

struct RatePlanAiHandoffActions: Sendable {
    var exportMarkdown: @MainActor () async throws -> TariffAiHandoffExportResponse
    var preview: @MainActor (String) async throws -> TariffAiHandoffPreviewResponse
    var commit: @MainActor (TariffAiHandoffCommitRequest) async throws -> TariffAiHandoffCommitResponse
}

@MainActor
@Observable
final class RatePlanAiHandoffModel {
    private(set) var markdown: String?
    private(set) var isLoadingMarkdown = false
    private(set) var exportError: String?

    var rawInput = "" {
        didSet {
            guard rawInput != oldValue else { return }
            preview = nil
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = false
            reviewError = nil
        }
    }

    private(set) var preview: TariffAiHandoffPreviewResponse?
    private(set) var isPreviewing = false
    private(set) var isApplying = false
    private(set) var reviewError: String?
    private(set) var isRefreshedAfterConflict = false
    private(set) var committedResponse: TariffAiHandoffCommitResponse?

    var isAcknowledged = false
    var isVerifiedAgainstBill = false

    @ObservationIgnored private let actions: RatePlanAiHandoffActions

    init(actions: RatePlanAiHandoffActions) {
        self.actions = actions
    }

    var canPreview: Bool {
        !isPreviewing && !isApplying && !rawInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canApply: Bool {
        guard let preview, preview.hasChanges else { return false }
        return isAcknowledged && !isPreviewing && !isApplying
    }

    func loadMarkdownIfNeeded() async {
        guard markdown == nil, !isLoadingMarkdown else { return }
        await reloadMarkdown()
    }

    func reloadMarkdown() async {
        isLoadingMarkdown = true
        exportError = nil
        defer { isLoadingMarkdown = false }
        do {
            markdown = try await actions.exportMarkdown().markdown
        } catch is CancellationError {
            return
        } catch {
            exportError = error.localizedDescription
        }
    }

    func loadPreview() async {
        guard canPreview else { return }
        isPreviewing = true
        reviewError = nil
        isRefreshedAfterConflict = false
        defer { isPreviewing = false }
        do {
            preview = try await actions.preview(rawInput)
            isAcknowledged = false
            isVerifiedAgainstBill = false
        } catch is CancellationError {
            return
        } catch {
            reviewError = error.localizedDescription
        }
    }

    @discardableResult
    func apply() async -> Bool {
        guard canApply, let currentPreview = preview else { return false }
        isApplying = true
        reviewError = nil
        defer { isApplying = false }
        let request = TariffAiHandoffCommitRequest(
            rawInput: rawInput,
            expectedReviewHash: currentPreview.reviewHash,
            verifiedAgainstBill: isVerifiedAgainstBill
        )
        do {
            committedResponse = try await actions.commit(request)
            return true
        } catch RatePlanSelectionError.aiHandoffReviewStale(let fresh) {
            preview = fresh
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = true
        } catch is CancellationError {
            return false
        } catch {
            reviewError = error.localizedDescription
        }
        return false
    }
}
