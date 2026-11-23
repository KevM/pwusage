import Foundation
import PWUsageCore

extension DashboardCoordinator {
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
}
