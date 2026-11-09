import Foundation

extension PWUsageAppModel {
    /// The site to ask about now, or nil. Re-evaluated whenever the site list, the selection or a
    /// sheet changes, so confirming a day (here or on the web) clears the prompt by itself.
    var billingDayPromptSite: MobileSite? {
        let site = sites.first { $0.id == selectedSiteID }
        let otherSheetPresented = isSitePickerPresented || isDemoSheetPresented
            || coordinator?.presentedSheet != nil || coordinator?.requiresTeslaReconnect == true
        let shouldPresent = billingDayPrompt.shouldPresent(
            site: site, isDemo: isDemo, sessionVerified: sessionVerified, otherSheetPresented: otherSheetPresented)
        return shouldPresent ? site : nil
    }

    /// Whether the selected site's billing day is still the unconfirmed default.
    var selectedSiteNeedsBillingDay: Bool {
        sites.first { $0.id == selectedSiteID }?.billingDayConfirmed == false
    }

    func dismissBillingDayPrompt() {
        guard let siteID = selectedSiteID else { return }
        billingDayPrompt.dismiss(siteID: siteID)
    }

    /// Saves the site's billing day, then refreshes the bill, whose cycle just moved.
    /// Throws when the server rejects the day or cannot be reached, leaving the site as it was.
    func saveBillingDay(_ day: Int, siteID: String) async throws {
        if isDemo { throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo is read-only") }
        let saved = try await api.setBillingDay(siteID: siteID, day: day)
        guard let index = sites.firstIndex(where: { $0.id == siteID }) else { return }
        sites[index] = sites[index].settingBillingDay(saved.billingDay)
        cache?.storeSites(sites)
        if siteID == selectedSiteID { await coordinator?.refreshBillDiscardingRunning() }
    }

    /// Picks up a billing day chosen elsewhere (the web app, another phone) while this one still
    /// asks. Only the billing fields of sites already installed change, and a failure changes nothing.
    func refreshBillingDays() async {
        guard sessionVerified, !isDemo else { return }
        let before = sites
        guard let fetched = try? await api.fetchSites() else { return }
        var updated = sites
        for index in updated.indices {
            // A save made while the request was in flight is newer than the response.
            let started = before.first { $0.id == updated[index].id }
            guard started?.billingDay == updated[index].billingDay,
                  started?.billingDayConfirmed == updated[index].billingDayConfirmed,
                  let match = fetched.first(where: { $0.id == updated[index].id }),
                  match.billingDay != updated[index].billingDay
                  || match.billingDayConfirmed != updated[index].billingDayConfirmed
            else { continue }
            updated[index] = MobileSite(
                id: updated[index].id, name: updated[index].name, utility: updated[index].utility,
                billingDay: match.billingDay, billingDayConfirmed: match.billingDayConfirmed)
        }
        guard updated != sites else { return }
        sites = updated
        cache?.storeSites(sites)
        if let siteID = selectedSiteID, updated.first(where: { $0.id == siteID }) != nil {
            await coordinator?.refreshBill(trigger: .automaticRecovery)
        }
    }
}
