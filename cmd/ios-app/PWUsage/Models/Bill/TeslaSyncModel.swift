import Foundation
import Observation

/// The server calls Sync to Tesla goes through: a preview, a commit of that preview's fingerprint,
/// the timeline to refetch when a commit does not return one, and the read-only pull from Tesla
/// that brings PWUsage's stored copy of Tesla's plan up to date.
struct TeslaSyncActions: Sendable {
    var preview: @MainActor () async throws -> TeslaSyncPreviewDTO
    var commit: @MainActor (String) async throws -> TeslaSyncResultDTO
    var refreshTimeline: @MainActor () async throws -> SiteTariffsTimelineResponse
    var pullFromTesla: @MainActor () async throws -> SiteTariffsTimelineResponse
}

/// One Sync to Tesla session: review what would be sent, then send it at most once.
/// A conflict reloads the review; it never writes a second time on its own.
@MainActor
@Observable
final class TeslaSyncModel {
    enum Phase: Equatable {
        case loading
        case review(TeslaSyncPreviewDTO)
        case unavailable(TeslaSyncUnavailability)
        case sending(TeslaSyncPreviewDTO)
        case finished(TeslaSyncResultDTO)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    /// A line shown above the review, e.g. after a conflict reloaded it. Cleared by the next load.
    private(set) var notice: String?
    @ObservationIgnored private let actions: TeslaSyncActions
    /// Hands the owner the timeline after a write, so its banner reflects the new state.
    @ObservationIgnored private let onTimeline: @MainActor (SiteTariffsTimelineResponse) -> Void

    init(actions: TeslaSyncActions, onTimeline: @escaping @MainActor (SiteTariffsTimelineResponse) -> Void) {
        self.actions = actions
        self.onTimeline = onTimeline
    }

    /// Problems replace the send button; the server would refuse the write too.
    var canConfirm: Bool {
        guard case .review(let preview) = phase else { return false }
        return preview.problems.isEmpty
    }

    func load() async {
        phase = .loading
        notice = nil
        do {
            phase = .review(try await actions.preview())
        } catch is CancellationError {
            return
        } catch let unavailable as TeslaSyncUnavailability {
            phase = .unavailable(unavailable)
            // PWUsage's copy of Tesla's plan is stale, so its banner is wrong: pull and hand the timeline back.
            if unavailable.reason == "no_difference" {
                await handOverPulledTimeline(fallingBack: false)
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Sends the reviewed plan. A second call while sending does nothing, so Tesla is written once.
    func confirm() async {
        guard canConfirm, case .review(let preview) = phase else { return }
        phase = .sending(preview)
        do {
            let result = try await actions.commit(preview.fingerprint)
            if result.outcome == "conflict" {
                await load()
                notice = TeslaSyncCopy.conflict
                return
            }
            phase = .finished(result)
            if result.outcome == "unconfirmed" {
                await handOverPulledTimeline(fallingBack: true, returned: result.timeline)
            } else if result.outcome == "confirmed" {
                await handOverTimeline(result.timeline)
            }
        } catch is CancellationError {
            phase = .failed(CancellationError().localizedDescription)
        } catch {
            phase = .failed(error.localizedDescription)
            // The write may have landed before the answer was lost, so the banner should reflect Tesla's state.
            if let refreshed = try? await actions.refreshTimeline() { onTimeline(refreshed) }
        }
    }

    /// Pulls Tesla's plan and hands back the timeline. With `fallingBack`, a failed pull uses the commit's
    /// timeline or a plain refetch instead.
    private func handOverPulledTimeline(fallingBack: Bool, returned: SiteTariffsTimelineResponse? = nil) async {
        if let pulled = try? await actions.pullFromTesla() {
            onTimeline(pulled)
        } else if fallingBack {
            await handOverTimeline(returned)
        }
    }

    private func handOverTimeline(_ returned: SiteTariffsTimelineResponse?) async {
        if let returned {
            onTimeline(returned)
        } else if let refreshed = try? await actions.refreshTimeline() {
            onTimeline(refreshed)
        }
    }
}
