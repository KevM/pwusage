import Foundation

extension DashboardCoordinator {
    /// Most relevant reference period for editing in the fixed rate plan sheet.
    var activeReferencePeriod: TariffPeriodDTO? {
        guard let periods = savingsTimeline?.referencePeriods else { return nil }
        return periods.first(where: \.isCurrentToday) ?? periods.last
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
                let patch = TariffPlanPatchRequest(
                    name: request.name,
                    effectiveFrom: request.effectiveFrom,
                    effectiveTo: .set(request.effectiveTo),
                    seasons: request.seasons
                )
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
