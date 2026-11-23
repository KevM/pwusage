import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

/// The demo follows the same rate plan paths as a signed-in site: the savings button opens Rate
/// Plans, where comparison rows split at the demo's revision and Change reviews and applies.
@MainActor
@Suite("Demo rate plans")
struct DemoRatePlansTests {
    private let suiteName = "pwusage.demo.tests.\(UUID().uuidString)"

    private func demoCoordinator() async throws -> DashboardCoordinator {
        let model = DemoSession.makeModel(suiteName: suiteName)
        await model.bootstrap()
        let coordinator = try #require(model.coordinator)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshAll(trigger: .userGesture)
        await coordinator.refreshSavings()
        return coordinator
    }

    @Test("In demo mode the savings button opens Rate Plans and loading it makes no failing call")
    func demoSavingsButtonOpensRatePlans() async throws {
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let coordinator = try await demoCoordinator()
        let timeline = try #require(coordinator.savingsTimeline)

        let entry = SavingsPresentation.ratePlansEntry(hasRatePlans: !timeline.periods.isEmpty)
        #expect(entry.title == "Edit Rate Plans")
        #expect(!entry.startsAdding)

        // What the Rate Plans sheet and a row's Change call, all against the demo API.
        let actions = TariffTimelineActions.live(coordinator)
        let loaded = try await actions.load()
        #expect(loaded.supportsRatePlanSelection)
        let plans = try await actions.publicPlans("2026-01-01")
        #expect(plans.plans.contains { $0.kind == .fixed && $0.isDefault == true })
        let fixed = try #require(plans.plans.first { $0.kind == .fixed })
        let request = TariffSelectionRequest(
            scope: .reference, candidate: .publicPlan(label: fixed.label),
            effectiveFrom: "2026-01-01", effectiveTo: "2026-03-31"
        )
        let preview = try await actions.previewSelection(request)
        #expect(preview.scope == .reference)
        #expect(preview.effectiveFrom == "2026-01-01")
        let applied = try await actions.commitSelection(
            TariffSelectionCommit(request: request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false)
        )
        #expect(applied.timeline.supportsRatePlanSelection)
    }

    @Test("Demo savings reach ready with flow history, so the Bill card shows Edit Rate Plans")
    func demoSavingsAreReady() async throws {
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let coordinator = try await demoCoordinator()
        // Flow history syncs in the background; refreshing again after it lands is what the app does.
        func isReady() -> Bool {
            if case .ready = coordinator.savingsModel.state { return true }
            return false
        }
        var attempts = 0
        while attempts < 50, !isReady() {
            attempts += 1
            try await Task.sleep(for: .milliseconds(100))
            await coordinator.refreshSavings()
        }
        guard case .ready(let report) = coordinator.savingsModel.state else {
            Issue.record("Demo savings must reach ready, got \(coordinator.savingsModel.state)")
            return
        }
        #expect(SavingsPresentation.showsCard(report.cycle))
        let timeline = try #require(coordinator.savingsTimeline)
        #expect(SavingsPresentation.ratePlansEntry(hasRatePlans: !timeline.periods.isEmpty).title == "Edit Rate Plans")
    }

    @Test("Demo reference periods span two plans and split at a mid-plan revision")
    func demoComparisonSplitsAtRevision() throws {
        let timeline = DemoFixtures.tariffs(asOf: .now)
        let plans = timeline.periods.sorted { $0.effectiveFrom < $1.effectiveFrom }
        let rowsByPlan = plans.map {
            FixedComparisonPairing.rows(for: ($0.effectiveFrom, $0.effectiveTo), references: timeline.referencePeriods)
        }
        #expect(rowsByPlan.count == 2)
        #expect(rowsByPlan[0].count == 1)
        #expect(rowsByPlan[1].count == 2)
        #expect(rowsByPlan.joined().allSatisfy { $0.reference != nil })
        // One comparison period covers the end of the earlier plan and the start of the later one.
        let spanning = timeline.referencePeriods.filter { period in
            timeline.periods.filter {
                $0.effectiveFrom <= (period.effectiveTo ?? "9999") && ($0.effectiveTo ?? "9999") >= period.effectiveFrom
            }.count == 2
        }
        #expect(spanning.count == 1)
    }

    @Test("Changing a demo row replaces exactly its dates")
    func demoChangeReplacesRowDates() async throws {
        defer { DemoSession.tearDown(suiteName: suiteName) }
        let coordinator = try await demoCoordinator()
        let actions = TariffTimelineActions.live(coordinator)
        let before = try await actions.load()
        let currentMatch = before.periods.first(where: \.isCurrentToday)
        let current = try #require(currentMatch)
        let currentRows = FixedComparisonPairing.rows(
            for: (current.effectiveFrom, current.effectiveTo), references: before.referencePeriods
        )
        let firstRow = try #require(currentRows.first)
        let request = FixedRatePlanDraft.makeSelectionRequest(
            name: "My flat rate", buyRate: 0.2, sellRate: 0, range: (firstRow.from, firstRow.to)
        )
        let preview = try await actions.previewSelection(request)
        let applied = try await actions.commitSelection(
            TariffSelectionCommit(request: request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false)
        )
        let rows = FixedComparisonPairing.rows(
            for: (current.effectiveFrom, current.effectiveTo), references: applied.timeline.referencePeriods
        )
        #expect(rows.count == 2)
        #expect(rows.first?.reference?.name == "My flat rate")
        #expect(rows.first?.from == firstRow.from)
        #expect(rows.first?.to == firstRow.to)
        #expect(rows.last?.reference?.name != "My flat rate")
        #expect(rows.allSatisfy { $0.reference != nil })
    }
}
