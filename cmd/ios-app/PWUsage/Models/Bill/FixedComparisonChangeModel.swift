import Foundation
import Observation
import PWUsageCore

/// Change for one fixed comparison row in the rate plan editor: the fixed plans in effect when the row
/// starts, then the server's review of a reference-scope selection for exactly the row's dates.
/// A row, gaps included, offers the utility's fixed plans first; only no match goes straight to entering rates.
@MainActor
@Observable
final class FixedComparisonChangeModel {
    enum State: Equatable {
        case loading
        case choosing([FixedComparisonOption])
        case enteringRates
        case failed(String)
    }

    let row: FixedComparisonRow
    private(set) var state: State = .loading
    private(set) var review: RatePlanReviewModel?
    @ObservationIgnored private var offered: [FixedComparisonOption] = []

    @ObservationIgnored private let selection: RatePlanSelectionActions
    @ObservationIgnored private let loadPlans: @MainActor (String) async throws -> PublicUtilityPlansResponse

    init(
        row: FixedComparisonRow,
        selection: RatePlanSelectionActions,
        loadPlans: @escaping @MainActor (String) async throws -> PublicUtilityPlansResponse
    ) {
        self.row = row
        self.selection = selection
        self.loadPlans = loadPlans
    }

    var lockedRange: (from: String, to: String?) { (row.from, row.to) }

    func load() async {
        state = .loading
        do {
            let response = try await loadPlans(row.from)
            let options = FixedComparisonPicker.options(from: response.plans)
            offered = options
            state = options.isEmpty ? .enteringRates : .choosing(options)
        } catch is CancellationError {
            state = .loading
        } catch RatePlanSelectionError.publicPlansUnavailable {
            state = .enteringRates
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func enterRates() {
        state = .enteringRates
    }

    /// Back from entering rates to the picker; false when no plans were offered.
    @discardableResult
    func backToPicker() -> Bool {
        guard !offered.isEmpty else { return false }
        state = .choosing(offered)
        return true
    }

    func request(forLabel label: String) -> TariffSelectionRequest {
        TariffSelectionRequest(
            scope: .reference, candidate: .publicPlan(label: label), effectiveFrom: row.from, effectiveTo: row.to
        )
    }

    /// The review for choosing `label`; the same model while the request is unchanged.
    @discardableResult
    func startReview(label: String) -> RatePlanReviewModel {
        let request = request(forLabel: label)
        if let review, review.request == request { return review }
        let fresh = RatePlanReviewModel(request: request, actions: selection)
        review = fresh
        return fresh
    }
}
