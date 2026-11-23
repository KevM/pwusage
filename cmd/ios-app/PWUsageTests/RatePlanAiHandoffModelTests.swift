import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@MainActor
struct RatePlanAiHandoffModelTests {
    private static func makePreview(hash: String = "hash-1") throws -> TariffAiHandoffPreviewResponse {
        let json = RatePlanResponseFixture.batchPreviewJSON
            .replacingOccurrences(of: "batch-hash-1", with: hash)
        return try MobileContractDecoder.make().decode(TariffAiHandoffPreviewResponse.self, from: Data(json.utf8))
    }

    @Test("Extracts JSON from surrounding Markdown and prose before previewing")
    func stripsProseAndMarkdownAroundJSON() async {
        var sentRawInput: String?
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { input in
                    sentRawInput = input
                    return try Self.makePreview()
                },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            )
        )
        model.rawInput = """
        Here is what I found for your utility:

        ```json
        {"schema":"pwusage-rate-plan-handoff/v1","actualPeriods":[]}
        ```

        Hope that helps!
        """
        await model.loadPreview()

        #expect(sentRawInput == #"{"schema":"pwusage-rate-plan-handoff/v1","actualPeriods":[]}"#)
        #expect(model.presentedPreview?.reviewHash == "hash-1")
        #expect(model.reviewError == nil)
    }

    @Test("Shows inline validation error when pasted text has invalid JSON or wrong schema")
    func showsInlineErrorForInvalidInput() async {
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in try Self.makePreview() },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            )
        )

        model.rawInput = "No JSON here"
        await model.loadPreview()
        #expect(model.reviewError != nil)
        #expect(model.presentedPreview == nil)

        model.rawInput = #"{"schema":"wrong/v1"}"#
        await model.loadPreview()
        #expect(model.reviewError?.contains("pwusage-rate-plan-handoff/v1") == true)
        #expect(model.presentedPreview == nil)
    }

    @Test("Editing rawInput invalidates loaded preview and resets acknowledgement and bill verification")
    func editingInputInvalidatesReview() async {
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in try Self.makePreview() },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            )
        )
        model.rawInput = #"{"schema":"pwusage-rate-plan-handoff/v1"}"#
        await model.loadPreview()
        #expect(model.preview != nil)
        #expect(model.presentedPreview != nil)

        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true
        #expect(model.canApply)

        model.rawInput = #"{"schema":"pwusage-rate-plan-handoff/v1", "notes":["changed"]}"#
        #expect(model.preview == nil)
        #expect(model.presentedPreview == nil)
        #expect(!model.isAcknowledged)
        #expect(!model.isVerifiedAgainstBill)
        #expect(!model.canApply)
    }

    @Test("Stale review 409 replaces preview and clears both acknowledgement and verification")
    func staleReviewReplacesPreviewAndClearsToggles() async throws {
        let freshPreview = try Self.makePreview(hash: "hash-fresh")
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in try Self.makePreview(hash: "hash-initial") },
                commit: { _ in throw RatePlanSelectionError.aiHandoffReviewStale(freshPreview) }
            )
        )
        model.rawInput = #"{"schema":"pwusage-rate-plan-handoff/v1"}"#
        await model.loadPreview()
        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true

        let applied = await model.apply()
        #expect(!applied)
        #expect(model.preview?.reviewHash == "hash-fresh")
        #expect(model.presentedPreview?.reviewHash == "hash-fresh")
        #expect(!model.isAcknowledged)
        #expect(!model.isVerifiedAgainstBill)
        #expect(model.isRefreshedAfterConflict)
    }

    @Test("AI handoff provenance displays Imported with AI assistant separately from manual edits")
    func aiHandoffProvenanceLabel() {
        #expect(
            RatePlanSourcePresentation.sourceLabel(.manual, candidateKind: .aiHandoff)
                == "Imported with AI assistant"
        )
        #expect(RatePlanSourcePresentation.sourceLabel(.manual, candidateKind: .manual) == "Entered by you")
    }

    @Test("Discards in-flight preview response if rawInput changes before completion")
    func discardsStalePreviewWhenInputChangesInFlight() async {
        final class ModelBox: @unchecked Sendable {
            weak var model: RatePlanAiHandoffModel?
        }
        let box = ModelBox()
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in
                    await Task.yield()
                    await MainActor.run {
                        box.model?.rawInput = #"{"schema":"pwusage-rate-plan-handoff/v1","notes":["newer"]}"#
                    }
                    return try Self.makePreview(hash: "stale-hash")
                },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            )
        )
        box.model = model
        model.rawInput = #"{"schema":"pwusage-rate-plan-handoff/v1"}"#

        await model.loadPreview()

        #expect(model.preview == nil)
        #expect(model.presentedPreview == nil)
    }
}
