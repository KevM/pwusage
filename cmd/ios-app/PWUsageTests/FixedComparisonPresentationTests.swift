import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Fixed comparison rows and picker")
struct FixedComparisonPresentationTests {
    private static func reference(
        name: String = "Standard Residential", from: String = "2024-01-01", to: String? = "2024-12-31",
        source: TariffSource = .estimated, rate: Double = 0.16
    ) -> TariffPeriodDTO {
        let window = TimePeriodWindowInput(
            touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: rate, sellRate: 0
        )
        let season = TariffSeasonInput(
            name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: 1, tariffId: 1, name: name, version: 1, source: source, effectiveFrom: from,
            effectiveTo: to, isCurrentToday: false, updatedBy: nil, seasons: [season]
        )
    }

    private static func row(_ reference: TariffPeriodDTO?, from: String = "2024-01-01", to: String? = "2024-12-31")
        -> FixedComparisonRow {
        FixedComparisonRow(from: from, to: to, reference: reference)
    }

    private static func plan(
        _ label: String, kind: RatePlanKind? = .fixed, isDefault: Bool? = nil, rate: Double? = 0.16
    ) -> UtilityPlanDTO {
        let seasons = rate.map { rate -> [TariffSeasonInput] in
            let window = TimePeriodWindowInput(
                touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: rate, sellRate: 0
            )
            return [TariffSeasonInput(
                name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window]
            )]
        }
        return UtilityPlanDTO(
            label: label, name: "Plan \(label)", startDate: "2020-01-01", kind: kind, isDefault: isDefault,
            seasons: seasons
        )
    }

    // MARK: Row copy

    @Test func rowShowsNameAndCurrencyFormattedRate() {
        let row = Self.row(Self.reference())
        #expect(FixedComparisonPresentation.title(row) == "Standard Residential")
        #expect(FixedComparisonPresentation.rate(row, currency: "USD") == "$0.16 / kWh")
        #expect(FixedComparisonPresentation.isEstimated(row))
    }

    @Test func estimatedBadgeOnlyForEstimatedStoredReferences() {
        #expect(!FixedComparisonPresentation.isEstimated(Self.row(Self.reference(source: .manual))))
        #expect(!FixedComparisonPresentation.isEstimated(Self.row(nil)))
        let staged = FixedComparisonChoice.publicPlan(label: "L", name: "Plan", buyRate: 0.2)
            .stagedReference(from: "2024-01-01", to: nil)
        #expect(!FixedComparisonPresentation.isEstimated(Self.row(staged)))
    }

    @Test func detailJoinsRateAndBadge() {
        #expect(FixedComparisonPresentation.detail(Self.row(Self.reference()), currency: "USD")
            == "$0.16 / kWh · Estimated")
        #expect(FixedComparisonPresentation.detail(Self.row(Self.reference(source: .manual)), currency: "USD")
            == "$0.16 / kWh")
    }

    @Test func gapRowReadsNoFixedComparisonYet() {
        let gap = Self.row(nil)
        #expect(FixedComparisonPresentation.title(gap) == "No fixed comparison yet")
        #expect(FixedComparisonPresentation.rate(gap, currency: "USD") == nil)
        #expect(FixedComparisonPresentation.detail(gap, currency: "USD") == nil)
    }

    @Test func rowRangeUsesTheClippedDates() {
        #expect(FixedComparisonPresentation.range(Self.row(nil, from: "2024-03-01", to: nil))
            == "Mar 1, 2024 – Present")
    }

    @Test func footerAndButtonCopy() {
        #expect(FixedComparisonPresentation.footer
            == "Savings compare each plan with this fixed plan. Changing it never changes the plan for your energy.")
        #expect(FixedComparisonPresentation.heading == "Fixed comparison plan")
        #expect(FixedComparisonPresentation.changeTitle == "Change")
        #expect(FixedComparisonPresentation.enterRatesTitle == "Enter rates myself")
    }

    // MARK: Picker

    @Test func fixedPlansKeepsFixedAndPutsTheDefaultFirst() {
        let plans = [
            Self.plan("TOU", kind: .timeOfUse), Self.plan("A"), Self.plan("B", isDefault: true),
            Self.plan("C", isDefault: false), Self.plan("Legacy", kind: nil)
        ]
        #expect(FixedComparisonPicker.fixedPlans(plans).map(\.label) == ["B", "A", "C"])
    }

    @Test func optionsCarryTheFirstFlatRate() throws {
        let options = FixedComparisonPicker.options(from: [Self.plan("A"), Self.plan("B", rate: nil)])
        #expect(options.map(\.label) == ["A", "B"])
        #expect(options.first?.buyRate == 0.16)
        #expect(options.last?.buyRate == nil)
        #expect(options.first?.rateText(currency: "USD") == "$0.16 / kWh")
        #expect(options.last?.rateText(currency: "USD") == nil)
    }

    // MARK: Change model

    @MainActor
    @Test func changeModelOffersFixedPlansAtTheRowStart() async throws {
        let asked = Box()
        let model = FixedComparisonChangeModel(
            row: Self.row(Self.reference(), from: "2024-03-01", to: "2024-12-31"),
            selection: RatePlanSelectionActions(
                preview: { _ in throw PWUsageAPIError.invalidResponse },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            ),
            loadPlans: { date in
                asked.date = date
                return PublicUtilityPlansResponse(
                    utilityName: "U", effectiveDate: date, currency: "USD",
                    plans: [Self.plan("TOU", kind: .timeOfUse), Self.plan("FIX")]
                )
            }
        )
        await model.load()
        #expect(asked.date == "2024-03-01")
        #expect(model.state == .choosing(FixedComparisonPicker.options(from: [Self.plan("FIX")])))
        let request = model.request(forLabel: "FIX")
        #expect(request == TariffSelectionRequest(
            scope: .reference, candidate: .publicPlan(label: "FIX"), effectiveFrom: "2024-03-01",
            effectiveTo: "2024-12-31"
        ))
    }

    @MainActor
    @Test func changeModelGoesStraightToRatesOnlyWhenNoFixedPlanMatchesAndReportsFailures() async {
        let noNetwork = RatePlanSelectionActions(
            preview: { _ in throw PWUsageAPIError.invalidResponse },
            commit: { _ in throw PWUsageAPIError.invalidResponse }
        )
        let gap = FixedComparisonChangeModel(row: Self.row(nil), selection: noNetwork) { date in
            PublicUtilityPlansResponse(
                utilityName: "U", effectiveDate: date, currency: "USD", plans: [Self.plan("FIX")]
            )
        }
        await gap.load()
        #expect(gap.state == .choosing(FixedComparisonPicker.options(from: [Self.plan("FIX")])))
        gap.enterRates()
        #expect(gap.state == .enteringRates)
        #expect(gap.backToPicker())
        #expect(gap.state == .choosing(FixedComparisonPicker.options(from: [Self.plan("FIX")])))

        let uncovered = FixedComparisonChangeModel(row: Self.row(nil), selection: noNetwork) { date in
            PublicUtilityPlansResponse(utilityName: "U", effectiveDate: date, currency: "USD", plans: [])
        }
        await uncovered.load()
        #expect(uncovered.state == .enteringRates)
        #expect(!uncovered.backToPicker())

        let none = FixedComparisonChangeModel(row: Self.row(Self.reference()), selection: noNetwork) { date in
            PublicUtilityPlansResponse(
                utilityName: "U", effectiveDate: date, currency: "USD", plans: [Self.plan("TOU", kind: .timeOfUse)]
            )
        }
        await none.load()
        #expect(none.state == .enteringRates)

        let failing = FixedComparisonChangeModel(row: Self.row(Self.reference()), selection: noNetwork) { _ in
            throw PWUsageAPIError.invalidResponse
        }
        await failing.load()
        guard case .failed = failing.state else {
            Issue.record("a failed load must say so, not hide the plans")
            return
        }
    }

    @MainActor
    @Test func changeModelStartsOneReviewPerRequest() {
        let model = FixedComparisonChangeModel(
            row: Self.row(Self.reference()),
            selection: RatePlanSelectionActions(
                preview: { _ in throw PWUsageAPIError.invalidResponse },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            ),
            loadPlans: { _ in throw PWUsageAPIError.invalidResponse }
        )
        let first = model.startReview(label: "FIX")
        #expect(model.startReview(label: "FIX") === first)
        #expect(model.startReview(label: "OTHER") !== first)
    }

    @Test func lockedRangeRequestSendsExactlyThatRange() throws {
        let request = FixedRatePlanDraft.makeSelectionRequest(
            name: "Mine", buyRate: 0.2, sellRate: 0, range: (from: "2024-03-01", to: "2024-12-31")
        )
        #expect(request.scope == .reference)
        #expect(request.effectiveFrom == "2024-03-01")
        #expect(request.effectiveTo == "2024-12-31")
        let open = FixedRatePlanDraft.makeSelectionRequest(
            name: " ", buyRate: 0.2, sellRate: 0, range: (from: "2025-01-01", to: nil)
        )
        #expect(open.effectiveTo == nil)
        if case let .manual(name, seasons) = open.candidate {
            #expect(name == "Fixed comparison plan")
            #expect(seasons.first?.weekdayPeriods.first?.buyRate == 0.2)
        } else {
            Issue.record("expected a manual candidate")
        }
    }
}

private final class Box: @unchecked Sendable {
    var date: String?
}
