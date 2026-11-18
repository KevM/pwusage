import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Reviewing a rate plan change before it applies")
struct RatePlanReviewModelTests {
    static func preview(
        hash: String = "hash-1",
        canRestore: Bool = true,
        fromHistoryStart: Bool = false
    ) throws -> TariffSelectionPreviewResponse {
        let json = MobileTariffsDecodingTests.previewJSON
            .replacingOccurrences(of: "\"hash-1\"", with: "\"\(hash)\"")
            .replacingOccurrences(of: "\"canApplyRestoration\": true", with: "\"canApplyRestoration\": \(canRestore)")
            .replacingOccurrences(
                of: "\"recalculatesFromHistoryStart\": false",
                with: "\"recalculatesFromHistoryStart\": \(fromHistoryStart)"
            )
        return try MobileContractDecoder.make().decode(TariffSelectionPreviewResponse.self, from: Data(json.utf8))
    }

    static let request = TariffSelectionRequest(
        scope: .actual, candidate: .publicPlan(label: "abc"), effectiveFrom: "2025-03-01", effectiveTo: nil
    )

    final class Spy {
        var previews: [TariffSelectionRequest] = []
        var commits: [TariffSelectionCommit] = []
        var previewResult: Result<TariffSelectionPreviewResponse, any Error>
        var commitError: (any Error)?

        init(preview: TariffSelectionPreviewResponse) { previewResult = .success(preview) }

        @MainActor var actions: RatePlanSelectionActions {
            RatePlanSelectionActions(
                preview: { request in
                    self.previews.append(request)
                    return try self.previewResult.get()
                },
                commit: { commit in
                    self.commits.append(commit)
                    if let error = self.commitError { throw error }
                    let timeline = SiteTariffsTimelineResponse(
                        version: 2, siteId: "site-1", timezone: "America/Chicago", currency: "USD", periods: [],
                        reattribution: nil,
                        teslaSync: TeslaSyncDTO(
                            latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil,
                            activeManualUpdatedAt: nil, differsFromActiveManual: false
                        )
                    )
                    return TariffSelectionCommitResponse(
                        selectionIds: [1], tariffIds: [2], createdNewTariffVersion: true, unchanged: false,
                        reattributionRange: nil, timeline: timeline
                    )
                }
            )
        }
    }

    @Test("Applying needs acknowledgement; bill verification stays unchecked unless chosen")
    func acknowledgementRequired() async throws {
        let spy = try Spy(preview: Self.preview())
        let model = RatePlanReviewModel(request: Self.request, actions: spy.actions)
        await model.load()
        #expect(model.preview?.reviewHash == "hash-1")
        #expect(!model.canApply)
        #expect(await model.apply() == false)
        #expect(spy.commits.isEmpty)

        #expect(!model.isVerifiedAgainstBill, "Applying never implies bill verification")
        model.isAcknowledged = true
        #expect(await model.apply())
        #expect(spy.commits.first == TariffSelectionCommit(
            request: Self.request, expectedReviewHash: "hash-1", verifiedAgainstBill: false
        ))
    }

    @Test("Bill verification is sent only when the owner checks it")
    func verificationIsExplicit() async throws {
        let spy = try Spy(preview: Self.preview())
        let model = RatePlanReviewModel(request: Self.request, actions: spy.actions)
        await model.load()
        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true
        await model.apply()
        #expect(spy.commits.first?.verifiedAgainstBill == true)
    }

    @Test("A stale review shows the fresh one and asks again instead of applying it")
    func staleReviewReturnsToReview() async throws {
        let spy = try Spy(preview: Self.preview())
        spy.commitError = try RatePlanSelectionError.reviewStale(Self.preview(hash: "hash-2"))
        let model = RatePlanReviewModel(request: Self.request, actions: spy.actions)
        await model.load()
        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true
        #expect(await model.apply() == false)
        #expect(spy.commits.count == 1, "No automatic second commit")
        #expect(!model.isVerifiedAgainstBill, "Bill verification was for the old rates")
        #expect(model.preview?.reviewHash == "hash-2")
        #expect(model.isRefreshedAfterConflict)
        #expect(!model.isAcknowledged)
        #expect(!model.canApply)
    }

    @Test("A failed apply keeps the review on screen with the error")
    func failedApply() async throws {
        let spy = try Spy(preview: Self.preview())
        spy.commitError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        let model = RatePlanReviewModel(request: Self.request, actions: spy.actions)
        await model.load()
        model.isAcknowledged = true
        await model.apply()
        #expect(model.preview?.reviewHash == "hash-1")
        #expect(model.applyError != nil)
    }

    @Test("A restoration with no saved Tesla original can't be applied")
    func restorationUnavailable() async throws {
        let spy = try Spy(preview: Self.preview(canRestore: false))
        let restore = TariffSelectionRequest(
            scope: .actual, candidate: .restoreTesla(originalSelectionID: 4),
            effectiveFrom: "2025-03-01", effectiveTo: nil
        )
        let model = RatePlanReviewModel(request: restore, actions: spy.actions)
        await model.load()
        model.isAcknowledged = true
        #expect(!model.canApply)
    }

    @Test("A preview failure is shown and can be retried")
    func previewFailure() async throws {
        let spy = try Spy(preview: Self.preview())
        spy.previewResult = .failure(PWUsageAPIError.requestRejected(statusCode: 400, message: "Bad dates."))
        let model = RatePlanReviewModel(request: Self.request, actions: spy.actions)
        await model.load()
        #expect(model.phase == .failed("Bad dates."))
        spy.previewResult = try .success(Self.preview())
        await model.load()
        #expect(model.preview != nil)
        #expect(spy.previews.count == 2)
    }
}
