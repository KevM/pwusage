import Foundation
import Observation

/// The server calls a rate plan change goes through: a review first, then applying that review.
struct RatePlanSelectionActions: Sendable {
    var preview: @MainActor (TariffSelectionRequest) async throws -> TariffSelectionPreviewResponse
    var commit: @MainActor (TariffSelectionCommit) async throws -> TariffSelectionCommitResponse
}

/// One review of one exact request. Nothing changes until the owner acknowledges the review and
/// applies it; verifying against a bill is a separate choice that starts unchecked. A change to
/// the request needs a new model, so an edit after review always means a fresh review.
@MainActor
@Observable
final class RatePlanReviewModel {
    enum Phase: Equatable {
        case loading
        case reviewing(TariffSelectionPreviewResponse)
        case failed(String)
        case applying(TariffSelectionPreviewResponse)
        case applied(TariffSelectionCommitResponse)
    }

    let request: TariffSelectionRequest
    private(set) var phase: Phase = .loading
    /// "I reviewed these changes": required to apply.
    var isAcknowledged = false
    /// "I checked these details against my utility bill": optional and separate.
    var isVerifiedAgainstBill = false
    /// The timeline changed under the review the owner saw, so this is a fresh one.
    private(set) var isRefreshedAfterConflict = false
    private(set) var applyError: String?

    @ObservationIgnored private let actions: RatePlanSelectionActions

    init(request: TariffSelectionRequest, actions: RatePlanSelectionActions) {
        self.request = request
        self.actions = actions
    }

    var preview: TariffSelectionPreviewResponse? {
        switch phase {
        case .reviewing(let preview), .applying(let preview): preview
        case .loading, .failed, .applied: nil
        }
    }

    var isRestoration: Bool {
        if case .restoreTesla = request.candidate { return true }
        return false
    }

    /// A restoration with no saved Tesla original in range has nothing to apply.
    var canApply: Bool {
        guard case .reviewing(let preview) = phase, isAcknowledged else { return false }
        return !isRestoration || preview.restoration.canApplyRestoration
    }

    func load() async {
        phase = .loading
        applyError = nil
        do {
            phase = .reviewing(try await actions.preview(request))
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Applies exactly the review on screen. A conflict shows the server's fresh review and asks
    /// for acknowledgement again; it never retries on its own.
    @discardableResult
    func apply() async -> Bool {
        guard canApply, case .reviewing(let preview) = phase else { return false }
        applyError = nil
        phase = .applying(preview)
        let commit = TariffSelectionCommit(
            request: request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: isVerifiedAgainstBill
        )
        do {
            phase = .applied(try await actions.commit(commit))
            return true
        } catch RatePlanSelectionError.reviewStale(let fresh) {
            phase = .reviewing(fresh)
            // Both choices were made against the old details; ask for them again.
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = true
        } catch {
            phase = .reviewing(preview)
            applyError = error.localizedDescription
        }
        return false
    }
}
