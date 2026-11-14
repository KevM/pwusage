import Foundation

extension DashboardCoordinator {
    /// Most relevant reference period for editing in the fixed rate plan sheet.
    var activeReferencePeriod: TariffPeriodDTO? {
        guard let periods = savingsTimeline?.referencePeriods else { return nil }
        return periods.first(where: \.isCurrentToday) ?? periods.last
    }

    /// Recomputes cached savings from the stored rate-plan timeline and daily energy flows.
    func refreshSavings() async {
        let siteID = selectedSiteID
        let generation = siteGeneration
        guard let scope = tariffScope(siteID: siteID) else {
            savingsTimeline = nil
            savings = .notReady(.noTimeline)
            return
        }
        var timeline = await savedTimeline(for: scope)?.timeline
        if timeline == nil, canRequestAccountData {
            timeline = try? await revalidateTariffTimeline()
        }
        guard siteGeneration == generation else { return }
        savingsTimeline = timeline
        let updated = await savingsModel.refresh(
            scope: scope,
            timeline: timeline,
            billingDay: billingDay,
            now: now()
        )
        guard siteGeneration == generation else { return }
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
            await refreshSavings()
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
            await refreshSavings()
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
