import Foundation
import Observation
import PWUsageCore

/// Changing a rate plan to a public utility plan, or restoring the saved Tesla plan an override
/// replaced. Both need explicitly chosen dates and go through the same server review.
@MainActor
@Observable
final class RatePlanChangeModel {
    enum Kind: Equatable {
        case publicPlan
        /// Restores the Tesla originals saved for this override's selection.
        case restoreTesla(selectionID: Int, planName: String)
    }

    enum PlansState: Equatable {
        case idle
        case loading
        case loaded(PublicUtilityPlansResponse)
        case unavailable(String)
    }

    let kind: Kind
    let scope: TariffSelectionScope
    let timeZone: TimeZone
    /// Public plans are those in effect on the start date, so only a new start reloads them.
    var start: Date? {
        didSet {
            review = nil
            plans = .idle
        }
    }

    /// A new end needs a new review, but the plans on offer stay the same.
    var end: RatePlanEnd? {
        didSet { review = nil }
    }

    private(set) var plans: PlansState = .idle
    private(set) var review: RatePlanReviewModel?

    @ObservationIgnored private let loadPlans: @MainActor (String) async throws -> PublicUtilityPlansResponse
    @ObservationIgnored private let selection: RatePlanSelectionActions

    init(
        kind: Kind,
        scope: TariffSelectionScope = .actual,
        timeZone: TimeZone,
        selection: RatePlanSelectionActions,
        loadPlans: @escaping @MainActor (String) async throws -> PublicUtilityPlansResponse = { _ in
            throw PWUsageAPIError.invalidResponse
        }
    ) {
        self.kind = kind
        self.scope = scope
        self.timeZone = timeZone
        self.selection = selection
        self.loadPlans = loadPlans
    }

    /// Site-calendar dates once both are chosen and in order.
    var dates: (from: String, to: String?)? {
        guard let start, let end else { return nil }
        let from = RatePlanTimelineFormatting.formatYMD(start, in: timeZone)
        switch end {
        case .ongoing:
            return (from, nil)
        case .endsOn(let date):
            let until = RatePlanTimelineFormatting.formatYMD(date, in: timeZone)
            return until >= from ? (from, until) : nil
        }
    }

    var datesProblem: String? {
        if start == nil { return "Choose a start date." }
        if end == nil { return "Choose an end date, or choose Ongoing." }
        return dates == nil ? "The end date must be on or after the start date." : nil
    }

    /// Public plans in effect on the chosen start date.
    func loadPublicPlans() async {
        guard let dates else { return }
        plans = .loading
        do {
            plans = .loaded(try await loadPlans(dates.from))
        } catch is CancellationError {
            plans = .idle
        } catch RatePlanSelectionError.publicPlansUnavailable {
            plans = .unavailable("Public utility rate plans are currently available for US homes.")
        } catch {
            plans = .unavailable(error.localizedDescription)
        }
    }

    @discardableResult
    func startReview(publicPlanLabel label: String? = nil) -> RatePlanReviewModel? {
        guard let dates else { return nil }
        let candidate: TariffSelectionCandidate
        switch kind {
        case .publicPlan:
            guard let label else { return nil }
            candidate = .publicPlan(label: label)
        case .restoreTesla(let selectionID, _):
            candidate = .restoreTesla(originalSelectionID: selectionID)
        }
        let request = TariffSelectionRequest(
            scope: scope, candidate: candidate, effectiveFrom: dates.from, effectiveTo: dates.to
        )
        if review?.request != request {
            review = RatePlanReviewModel(request: request, actions: selection)
        }
        return review
    }
}
