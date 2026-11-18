import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Changing to a public plan or restoring Tesla's")
struct RatePlanChangeModelTests {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt
    private static let march = RatePlanTimelineFormatting.parseYMD("2025-03-01", in: utc)
    private static let plansResponse = PublicUtilityPlansResponse(
        utilityName: "We Energies", effectiveDate: "2025-03-01", currency: "USD",
        plans: [UtilityPlanDTO(label: "abc", name: "Residential", startDate: "2024-06-01")]
    )

    @Test("Public plans load for the chosen start date, and only once both dates are chosen")
    func plansNeedDates() async throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        var requestedDates: [String] = []
        let model = RatePlanChangeModel(kind: .publicPlan, timeZone: Self.utc, selection: spy.actions) { date in
            requestedDates.append(date)
            return Self.plansResponse
        }
        #expect(model.datesProblem == "Choose a start date.")
        await model.loadPublicPlans()
        #expect(requestedDates.isEmpty)
        #expect(model.startReview(publicPlanLabel: "abc") == nil)

        model.start = Self.march
        #expect(model.datesProblem == "Choose an end date, or choose Ongoing.")
        model.end = .ongoing
        await model.loadPublicPlans()
        #expect(requestedDates == ["2025-03-01"], "The revision date is never used as the start date")
        #expect(model.plans == .loaded(Self.plansResponse))

        let review = try #require(model.startReview(publicPlanLabel: "abc"))
        #expect(review.request == TariffSelectionRequest(
            scope: .actual, candidate: .publicPlan(label: "abc"), effectiveFrom: "2025-03-01", effectiveTo: nil
        ))
    }

    @Test("Changing a date discards the plans and review chosen for the old dates")
    func dateChangeInvalidates() async throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        let model = RatePlanChangeModel(kind: .publicPlan, timeZone: Self.utc, selection: spy.actions) { _ in
            Self.plansResponse
        }
        model.start = Self.march
        model.end = .ongoing
        await model.loadPublicPlans()
        model.startReview(publicPlanLabel: "abc")
        model.end = .endsOn(RatePlanTimelineFormatting.parseYMD("2025-02-01", in: Self.utc) ?? .now)
        #expect(model.review == nil)
        #expect(model.plans == .idle)
        #expect(model.datesProblem == "The end date must be on or after the start date.")
    }

    @Test("Restoring reviews the override's saved Tesla originals for explicit dates")
    func restoration() throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        let model = RatePlanChangeModel(
            kind: .restoreTesla(selectionID: 12, planName: "My override"), timeZone: Self.utc, selection: spy.actions
        )
        #expect(model.startReview() == nil, "No dates are filled in for the owner")
        model.start = Self.march
        model.end = .endsOn(RatePlanTimelineFormatting.parseYMD("2025-03-31", in: Self.utc) ?? .now)
        let review = try #require(model.startReview())
        #expect(review.request.candidate == .restoreTesla(originalSelectionID: 12))
        #expect(review.request.effectiveTo == "2025-03-31")
    }

    @Test("Outside the US, public plans explain why they're unavailable")
    func ineligible() async throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        let model = RatePlanChangeModel(kind: .publicPlan, timeZone: Self.utc, selection: spy.actions) { _ in
            throw RatePlanSelectionError.publicPlansUnavailable(.outsideUS)
        }
        model.start = Self.march
        model.end = .ongoing
        await model.loadPublicPlans()
        #expect(model.plans == .unavailable("Public utility rate plans are currently available for US homes."))
    }
}
