import Foundation
import PWUsageCore

/// Reviewed rate plan changes for the demo home. A change replaces exactly the chosen dates in the
/// demo's in-memory timeline, the way the server does, so Rate Plans behaves like a signed-in site.
extension DemoAPI {
    func setSiteRateCountry(
        siteID: String,
        body _: SiteRateCountryWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func publicUtilityPlans(siteID _: String, effectiveDate: String) async throws -> PublicUtilityPlansResponse {
        DemoFixtures.publicPlans(effectiveDate: effectiveDate)
    }

    func previewTariffSelection(
        siteID: String,
        request: TariffSelectionRequest
    ) async throws -> TariffSelectionPreviewResponse {
        let timeline = try await fetchTariffTimeline(siteID: siteID)
        let chosen = try resolve(request)
        let existing = request.scope == .reference ? timeline.referencePeriods : timeline.periods
        let covered = existing.contains { Self.overlaps($0, request.effectiveFrom, request.effectiveTo) }
        let candidate = Self.snapshot(name: chosen.name, seasons: chosen.seasons, label: chosen.label)
        let before = existing.first { Self.overlaps($0, request.effectiveFrom, request.effectiveTo) }
        return TariffSelectionPreviewResponse(
            reviewHash: Self.reviewHash(for: request),
            siteId: siteID,
            scope: request.scope,
            effectiveFrom: request.effectiveFrom,
            effectiveTo: request.effectiveTo,
            currency: timeline.currency,
            unit: "kWh",
            timezone: timeline.timezone,
            holidaysUseWeekendSchedule: false,
            recalculatesHistory: false,
            recalculatesFromHistoryStart: false,
            recalculationRange: nil,
            affectsPowerwallPlan: false,
            candidatePlan: candidate,
            affectedIntervals: [TariffReviewAffectedInterval(
                effectiveFrom: request.effectiveFrom, effectiveTo: request.effectiveTo,
                kind: covered ? .replace : .fillGap,
                before: before.map { Self.snapshot(name: $0.name, seasons: $0.seasons, label: nil) },
                beforeIsFallback: false, after: candidate, seasons: [],
                hasBuyRateChanges: true, hasSellRateChanges: false, hasRateChanges: true,
                hasPeriodNameChanges: before?.name != chosen.name, restoration: .notApplicable
            )],
            unchangedOutsidePeriods: [],
            restoration: TariffReviewRestorationSummary(
                preservedOriginals: [], restoredOriginals: [], unavailableRanges: [], canApplyRestoration: false
            ),
            approximationNotes: [],
            summary: TariffReviewSummary(
                hasBuyRateChanges: true, hasSellRateChanges: false, hasRateChanges: true,
                hasPeriodNameChanges: before?.name != chosen.name, fillsGap: !covered, replacesExistingPlan: covered
            )
        )
    }

    func commitTariffSelection(
        siteID: String,
        commit: TariffSelectionCommit
    ) async throws -> TariffSelectionCommitResponse {
        let request = commit.request
        let current = try await fetchTariffTimeline(siteID: siteID)
        let chosen = try resolve(request)
        nextPeriodID += 1
        let created = TariffPeriodDTO(
            periodId: nextPeriodID, tariffId: nextPeriodID * 10, name: chosen.name, version: 1, source: .manual,
            effectiveFrom: request.effectiveFrom, effectiveTo: request.effectiveTo,
            isCurrentToday: Self.covers(request.effectiveFrom, request.effectiveTo, day: today),
            updatedBy: TariffUpdatedByDTO(email: nil, isCurrentUser: true), seasons: chosen.seasons,
            choiceKind: .owner, urdbLabel: chosen.label
        )
        let next: SiteTariffsTimelineResponse
        switch request.scope {
        case .reference:
            let kept = replacing(current.referencePeriods, with: created)
            next = replacingReferencePeriods(in: current, with: kept)
        case .actual:
            let kept = replacing(current.periods, with: created)
            next = SiteTariffsTimelineResponse(
                version: current.version, siteId: current.siteId, timezone: current.timezone,
                currency: current.currency, periods: kept, referencePeriods: current.referencePeriods,
                battery: current.battery, reattribution: current.reattribution, holidayDates: current.holidayDates,
                teslaSync: current.teslaSync, estimates: current.estimates, systemCosts: current.systemCosts,
                rateCountry: current.rateCountry
            )
        }
        demoTimeline = next
        return TariffSelectionCommitResponse(
            selectionIds: [nextPeriodID], tariffIds: [created.tariffId], createdNewTariffVersion: true,
            unchanged: false, reattributionRange: nil, timeline: next
        )
    }

    private var today: String { DemoFixtures.isoDay(yearsAgo: 0, asOf: now()) }

    private struct ChosenPlan {
        let name: String
        let label: String?
        let seasons: [TariffSeasonInput]
    }

    private func resolve(_ request: TariffSelectionRequest) throws -> ChosenPlan {
        switch request.candidate {
        case .publicPlan(let label):
            let plans = DemoFixtures.publicPlans(effectiveDate: request.effectiveFrom).plans
            guard let plan = plans.first(where: { $0.label == label }), let seasons = plan.seasons else {
                throw PWUsageAPIError.invalidResponse
            }
            return ChosenPlan(name: plan.name, label: label, seasons: seasons)
        case .manual(let name, let seasons):
            return ChosenPlan(name: name, label: nil, seasons: seasons)
        case .restoreTesla:
            throw PWUsageAPIError.invalidResponse
        }
    }

    private static func reviewHash(for request: TariffSelectionRequest) -> String {
        "demo-\(request.scope.rawValue)-\(request.effectiveFrom)-\(request.effectiveTo ?? "open")"
    }

    private static func snapshot(
        name: String,
        seasons: [TariffSeasonInput],
        label: String?
    ) -> TariffReviewPlanSnapshot {
        TariffReviewPlanSnapshot(
            tariffId: nil, version: nil, periodId: nil, selectionId: nil, name: name,
            utilityName: DemoFixtures.demoUtilityName, source: .manual, choiceKind: .owner, urdbLabel: label,
            revisionStart: nil, contentHash: nil, exportRateProvenance: .published,
            holidaysUseWeekendSchedule: false, seasons: seasons, approximationNotes: [], verification: nil
        )
    }

    private static func overlaps(_ period: TariffPeriodDTO, _ from: String, _ to: String?) -> Bool {
        period.effectiveFrom <= (to ?? "9999-12-31") && (period.effectiveTo ?? "9999-12-31") >= from
    }

    private static func covers(_ from: String, _ to: String?, day: String) -> Bool {
        from <= day && (to ?? "9999-12-31") >= day
    }

    /// `periods` with `created`'s dates carved out: a period reaching past either end keeps that part,
    /// and a period reaching past both keeps its tail as a new period.
    private func replacing(_ periods: [TariffPeriodDTO], with created: TariffPeriodDTO) -> [TariffPeriodDTO] {
        var result: [TariffPeriodDTO] = []
        for period in periods {
            guard Self.overlaps(period, created.effectiveFrom, created.effectiveTo) else {
                result.append(period)
                continue
            }
            var reusesID = true
            if period.effectiveFrom < created.effectiveFrom {
                result.append(trimmed(
                    period, id: period.periodId, from: period.effectiveFrom,
                    to: Self.shifted(created.effectiveFrom, by: -1)
                ))
                reusesID = false
            }
            if let createdEnd = created.effectiveTo, (period.effectiveTo ?? "9999-12-31") > createdEnd {
                nextPeriodID += reusesID ? 0 : 1
                result.append(trimmed(
                    period, id: reusesID ? period.periodId : nextPeriodID,
                    from: Self.shifted(createdEnd, by: 1), to: period.effectiveTo
                ))
            }
        }
        return (result + [created]).sorted { $0.effectiveFrom < $1.effectiveFrom }
    }

    private func trimmed(_ period: TariffPeriodDTO, id: Int, from: String, to: String?) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: id, tariffId: id == period.periodId ? period.tariffId : id * 10, name: period.name,
            version: period.version, source: period.source, effectiveFrom: from, effectiveTo: to,
            isCurrentToday: Self.covers(from, to, day: today), updatedBy: period.updatedBy, seasons: period.seasons,
            startSource: period.startSource
        )
    }

    private static func shifted(_ day: String, by days: Int) -> String {
        guard let date = RatePlanTimelineFormatting.parseYMD(day) else { return day }
        return RatePlanTimelineFormatting.formatYMD(date.addingTimeInterval(TimeInterval(days) * 86400))
    }
}
