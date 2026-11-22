import Foundation
import PWUsageCore

extension DashboardCoordinator {
    /// Most relevant reference period for editing in the fixed rate plan sheet.
    var activeReferencePeriod: TariffPeriodDTO? {
        guard let periods = savingsTimeline?.referencePeriods else { return nil }
        return periods.first(where: \.isCurrentToday) ?? periods.last
    }

    var earliestReferencePeriod: TariffPeriodDTO? {
        savingsTimeline?.referencePeriods.min { $0.effectiveFrom < $1.effectiveFrom }
    }

    /// The coverage note for editing `period` in the fixed rate plan sheet. History starts where the
    /// rate plan timeline does, since its estimates and backfill begin at the first day of data.
    func fixedPlanEstimateCoverageNote(editing period: TariffPeriodDTO?) -> String? {
        RateEstimatesPresentation.fixedPlanEstimateCoverageNote(
            editing: period,
            referencePeriods: savingsTimeline?.referencePeriods ?? [],
            historyStart: savingsTimeline?.periods.map(\.effectiveFrom).min()
        )
    }

    /// Recomputes cached savings from `overrideTimeline` (if provided) or the stored rate-plan timeline.
    func refreshSavings(timeline overrideTimeline: SiteTariffsTimelineResponse? = nil) async {
        let siteID = selectedSiteID
        let generation = siteGeneration
        guard let scope = tariffScope(siteID: siteID) else {
            savingsTimeline = nil
            savings = .notReady(.noTimeline)
            return
        }
        var timeline = overrideTimeline
        if timeline == nil {
            timeline = await savedTimeline(for: scope)?.timeline ?? savingsTimeline
        }
        if timeline == nil, canRequestAccountData {
            timeline = try? await revalidateTariffTimeline()
        }
        guard !Task.isCancelled, siteGeneration == generation else { return }
        savingsTimeline = timeline
        let updated = await savingsModel.refresh(
            scope: scope,
            timeline: timeline,
            billingDay: billingDay,
            now: now()
        )
        guard !Task.isCancelled, siteGeneration == generation else { return }
        savings = updated
    }

    /// Creates or updates the fixed-rate reference plan, returning an error message on failure.
    func saveFixedRatePlan(
        _ request: TariffPlanWriteRequest,
        editing existing: TariffPeriodDTO?
    ) async -> String? {
        do {
            let timeline: SiteTariffsTimelineResponse
            if let existing {
                let patch = FixedRatePlanDraft.makePatchRequest(request)
                timeline = try await updateReferenceRatePlan(periodID: existing.periodId, body: patch)
            } else {
                timeline = try await createReferenceRatePlan(request)
            }
            savingsTimeline = timeline
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Saves the system costs and recomputes savings from the returned timeline; returns an error message on failure.
    func saveSystemCosts(_ request: SystemCostsWriteRequest) async -> String? {
        do {
            let timeline = try await putSystemCosts(request)
            await refreshSavings(timeline: timeline)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Deletes a fixed-rate reference plan period, returning an error message on failure.
    func removeFixedRatePlan(periodID: Int) async -> String? {
        do {
            let timeline = try await deleteReferenceRatePlan(periodID: periodID)
            savingsTimeline = timeline
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
