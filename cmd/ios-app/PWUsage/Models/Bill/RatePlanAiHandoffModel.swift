import Foundation
import Observation

struct RatePlanAiHandoffActions: Sendable {
    var exportMarkdown: @MainActor () async throws -> TariffAiHandoffExportResponse
    var preview: @MainActor (String) async throws -> TariffAiHandoffPreviewResponse
    var commit: @MainActor (TariffAiHandoffCommitRequest) async throws -> TariffAiHandoffCommitResponse
}

enum RatePlanAiHandoffInputError: LocalizedError, Equatable {
    case empty
    case missingJSONObject
    case invalidJSON
    case unsupportedSchema(String?)

    var errorDescription: String? {
        switch self {
        case .empty:
            return "Paste the AI assistant response or JSON block to preview changes."
        case .missingJSONObject:
            return "Could not find a JSON object in the pasted text. Include the ```json block from your AI assistant."
        case .invalidJSON:
            return "Could not parse JSON from the pasted text. Check that the JSON block is complete."
        case .unsupportedSchema(let found):
            let expected = RatePlanAiHandoffModel.expectedSchema
            if let found, !found.isEmpty {
                return "Unsupported schema \"\(found)\". Expected \"\(expected)\"."
            }
            return "Missing schema field. Expected \"\(expected)\"."
        }
    }
}

@MainActor
@Observable
final class RatePlanAiHandoffModel {
    nonisolated static let expectedSchema = "pwusage-rate-plan-handoff/v1"

    private struct SchemaEnvelope: Decodable {
        let schema: String?
    }

    private(set) var markdown: String?
    private(set) var isLoadingMarkdown = false
    private(set) var exportError: String?

    var rawInput = "" {
        didSet {
            guard rawInput != oldValue else { return }
            inputRevision += 1
            extractedJSON = nil
            preview = nil
            presentedPreview = nil
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = false
            reviewError = nil
        }
    }

    private(set) var preview: TariffAiHandoffPreviewResponse?
    var presentedPreview: TariffAiHandoffPreviewResponse?
    private(set) var isPreviewing = false
    private(set) var isApplying = false
    private(set) var reviewError: String?
    private(set) var isRefreshedAfterConflict = false
    private(set) var committedResponse: TariffAiHandoffCommitResponse?

    var isAcknowledged = false
    var isVerifiedAgainstBill = false

    @ObservationIgnored private let actions: RatePlanAiHandoffActions
    @ObservationIgnored private var extractedJSON: String?
    @ObservationIgnored private var inputRevision = 0

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

    static func extractValidatedJSON(from rawInput: String) -> Result<String, RatePlanAiHandoffInputError> {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        guard let firstBrace = trimmed.firstIndex(of: "{"),
              let lastBrace = trimmed.lastIndex(of: "}"),
              firstBrace <= lastBrace
        else {
            return .failure(.missingJSONObject)
        }
        let candidate = String(trimmed[firstBrace ... lastBrace])
        guard let data = candidate.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(SchemaEnvelope.self, from: data)
        else {
            return .failure(.invalidJSON)
        }
        guard envelope.schema == expectedSchema else {
            return .failure(.unsupportedSchema(envelope.schema))
        }
        return .success(candidate)
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
        let cleanedJSON: String
        switch Self.extractValidatedJSON(from: rawInput) {
        case .success(let json):
            cleanedJSON = json
        case .failure(let error):
            reviewError = error.localizedDescription
            return
        }

        let requestRevision = inputRevision
        isPreviewing = true
        reviewError = nil
        isRefreshedAfterConflict = false
        defer { isPreviewing = false }
        do {
            let loaded = try await actions.preview(cleanedJSON)
            guard inputRevision == requestRevision else { return }
            extractedJSON = cleanedJSON
            preview = loaded
            presentedPreview = loaded
            isAcknowledged = false
            isVerifiedAgainstBill = false
        } catch is CancellationError {
            return
        } catch {
            guard inputRevision == requestRevision else { return }
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
            rawInput: extractedJSON ?? rawInput,
            expectedReviewHash: currentPreview.reviewHash,
            verifiedAgainstBill: isVerifiedAgainstBill
        )
        do {
            committedResponse = try await actions.commit(request)
            presentedPreview = nil
            return true
        } catch RatePlanSelectionError.aiHandoffReviewStale(let fresh) {
            preview = fresh
            presentedPreview = fresh
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
