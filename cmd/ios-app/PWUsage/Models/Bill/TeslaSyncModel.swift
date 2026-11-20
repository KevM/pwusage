import Foundation
import Observation

/// The server calls Sync to Tesla goes through: a preview, a commit of that preview's fingerprint,
/// and the timeline to refetch when a commit does not return one.
struct TeslaSyncActions: Sendable {
    var preview: @MainActor () async throws -> TeslaSyncPreviewDTO
    var commit: @MainActor (String) async throws -> TeslaSyncResultDTO
    var refreshTimeline: @MainActor () async throws -> SiteTariffsTimelineResponse
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
        do {
            phase = .review(try await actions.preview())
        } catch is CancellationError {
            return
        } catch let unavailable as TeslaSyncUnavailability {
            phase = .unavailable(unavailable)
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
                return
            }
            phase = .finished(result)
            if result.outcome == "confirmed" || result.outcome == "unconfirmed" {
                await handOverTimeline(result.timeline)
            }
        } catch {
            phase = .failed(error.localizedDescription)
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
