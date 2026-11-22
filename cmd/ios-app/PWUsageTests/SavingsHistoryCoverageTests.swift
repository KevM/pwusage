import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Whether savings cover the site's whole history")
struct SavingsHistoryCoverageTests {
    private static let zone = TimeZone(identifier: "America/Chicago") ?? .gmt
    /// Nov 18, 2025, local midnight.
    private static let firstStored = Date(timeIntervalSince1970: 1_763_445_600)

    private static func status(
        _ phase: SiteDeepHistoryPhase, loadedBack: String? = nil
    ) -> SiteDeepHistoryModel.Status {
        .init(phase: phase, loadedBack: loadedBack, daysLoaded: loadedBack == nil ? 0 : 30)
    }

    private static func coverage(_ status: SiteDeepHistoryModel.Status?) -> SavingsHistoryCoverage {
        SavingsHistoryCoverage(firstStoredDay: firstStored, olderHistory: status)
    }

    @Test("Only a finished walk, or no walk to run, counts as the whole history")
    func completeness() {
        #expect(Self.coverage(Self.status(.finished, loadedBack: "2023-11-14")) == .complete)
        #expect(Self.coverage(nil) == .complete, "Demo and signed-out sites have no walk")
        #expect(SavingsHistoryCoverage(firstStoredDay: nil, olderHistory: Self.status(.idle)) == .complete)
        #expect(Self.coverage(Self.status(.running)) == .loading(since: Self.firstStored))
        #expect(Self.coverage(Self.status(.waiting(until: .now))) == .loading(since: Self.firstStored))
        #expect(Self.coverage(Self.status(.idle)) == .partial(since: Self.firstStored, action: .load))
        #expect(Self.coverage(Self.status(.idle, loadedBack: "2025-06-01"))
            == .partial(since: Self.firstStored, action: .continueLoading))
        #expect(Self.coverage(Self.status(.paused(.reconnectTesla)))
            == .partial(since: Self.firstStored, action: .reconnectTesla))
        #expect(Self.coverage(Self.status(.unavailable)) == .partial(since: Self.firstStored, action: nil))
    }

    @Test("Lifetime is named for what it covers until the whole history is on the phone")
    func titlesAndNotes() {
        #expect(SavingsHistoryCoverage.complete.lifetimeTitle(timeZone: Self.zone) == "Lifetime")
        #expect(SavingsHistoryCoverage.complete.note == nil)
        let loading = Self.coverage(Self.status(.running))
        #expect(loading.lifetimeTitle(timeZone: Self.zone) == "Since Nov 18, 2025")
        #expect(loading.note == "Older history is loading, so this covers only the days loaded so far.")
        #expect(loading.actionTitle == nil)
        let partial = Self.coverage(Self.status(.idle))
        #expect(partial.note == "This covers only the history on this phone. Load older history to see your lifetime.")
        #expect(partial.actionTitle == "Load Older History")
        #expect(Self.coverage(Self.status(.idle, loadedBack: "2025-06-01")).actionTitle == "Continue Loading")
        let reconnect = Self.coverage(Self.status(.paused(.reconnectTesla)))
        #expect(reconnect.note == "This covers only the history on this phone. Reconnect Tesla to load the rest.")
        #expect(reconnect.actionTitle == "Reconnect Tesla")
        let unavailable = Self.coverage(Self.status(.unavailable))
        #expect(unavailable.note == "Earlier history isn’t available, so this covers only the days on this phone.")
        #expect(unavailable.actionTitle == nil)
    }

    @Test("Payback waits only while history that predates the phone's can still load")
    func paybackHold() {
        let costs = SystemCostsDTO(
            siteInstalled: "2023-11-14",
            solar: SystemCostDTO(installDate: nil, price: 20_000, taxCreditPercent: 30, incentives: 0)
        )
        let loading = Self.coverage(Self.status(.running))
        #expect(loading.holdsPayback(costs: costs, timeZone: Self.zone))
        #expect(loading.paybackNote
            == "Payback appears once older history finishes loading, so it counts every year since install.")
        let partial = Self.coverage(Self.status(.idle))
        #expect(partial.holdsPayback(costs: costs, timeZone: Self.zone))
        #expect(partial.paybackNote == "Payback needs your history back to install. Load older history to see it.")
        #expect(!Self.coverage(Self.status(.unavailable)).holdsPayback(costs: costs, timeZone: Self.zone),
                "Nothing more can load, so payback shows what there is")
        #expect(!SavingsHistoryCoverage.complete.holdsPayback(costs: costs, timeZone: Self.zone))
        let installedLater = SystemCostsDTO(
            siteInstalled: "2025-12-01",
            solar: SystemCostDTO(installDate: nil, price: 20_000, taxCreditPercent: 30, incentives: 0)
        )
        #expect(!loading.holdsPayback(costs: installedLater, timeZone: Self.zone),
                "The phone already holds every day since install")
    }
}
