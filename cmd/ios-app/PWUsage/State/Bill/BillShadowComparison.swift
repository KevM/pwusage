import Foundation

struct BillShadowPeriodSummary: Codable, Equatable, Sendable {
    let tariffName: String
    let periodName: String
    let cost: Double
}

struct BillShadowBillSummary: Codable, Equatable, Sendable {
    let estimatedCost: Double?
    let periods: [BillShadowPeriodSummary]

    init(from bill: MobileBillResponse.Bill) {
        estimatedCost = bill.estimatedCost
        periods = bill.periods.map {
            BillShadowPeriodSummary(
                tariffName: $0.tariffName,
                periodName: $0.periodName,
                cost: $0.cost
            )
        }
    }
}

struct BillShadowReport: Codable, Equatable, Sendable {
    let siteId: String
    let appBuild: String
    let cycleStart: Date
    let server: BillShadowBillSummary
    let local: BillShadowBillSummary
    let reattributionRunning: Bool
}

@MainActor
final class BillShadowDedupTracker {
    private struct CycleKey: Hashable {
        let siteID: String
        let cycleStart: Date
    }

    private var reportedCycles: Set<CycleKey> = []

    func shouldReport(siteID: String, cycleStart: Date) -> Bool {
        !reportedCycles.contains(CycleKey(siteID: siteID, cycleStart: cycleStart))
    }

    func markReported(siteID: String, cycleStart: Date) {
        reportedCycles.insert(CycleKey(siteID: siteID, cycleStart: cycleStart))
    }
}

enum BillShadowComparison {
    private struct PeriodKey: Hashable {
        let tariffName: String
        let periodName: String
    }

    static func differences(
        server: MobileBillResponse,
        local: MobileBillResponse,
        threshold: Double = 0.01
    ) -> BillShadowReport? {
        let totalDiffers = estimatedCostDiffers(
            server: server.currentBill.estimatedCost,
            local: local.currentBill.estimatedCost,
            threshold: threshold
        )
        let periodsDiffer = periodListsDiffer(
            server: server.currentBill.periods,
            local: local.currentBill.periods,
            threshold: threshold
        )
        guard totalDiffers || periodsDiffer else { return nil }

        let appBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        let reattributionRunning = server.tariffReattribution?.status == .running
            || local.tariffReattribution?.status == .running
        return BillShadowReport(
            siteId: server.site.id,
            appBuild: appBuild,
            cycleStart: server.currentBill.cycleStart,
            server: BillShadowBillSummary(from: server.currentBill),
            local: BillShadowBillSummary(from: local.currentBill),
            reattributionRunning: reattributionRunning
        )
    }

    private static func estimatedCostDiffers(
        server: Double?,
        local: Double?,
        threshold: Double
    ) -> Bool {
        switch (server, local) {
        case (.none, .none):
            false
        case (.some(let sCost), .some(let lCost)):
            abs(sCost - lCost) > threshold
        default:
            true
        }
    }

    private static func periodListsDiffer(
        server: [Period],
        local: [Period],
        threshold: Double
    ) -> Bool {
        let serverCosts = costsByPeriod(server)
        let localCosts = costsByPeriod(local)
        let allKeys = Set(serverCosts.keys).union(localCosts.keys)
        for key in allKeys {
            guard let sCost = serverCosts[key], let lCost = localCosts[key] else {
                return true
            }
            if abs(sCost - lCost) > threshold {
                return true
            }
        }
        return false
    }

    private static func costsByPeriod(_ periods: [Period]) -> [PeriodKey: Double] {
        var costs: [PeriodKey: Double] = [:]
        for period in periods {
            let key = PeriodKey(tariffName: period.tariffName, periodName: period.periodName)
            costs[key, default: 0] += period.cost
        }
        return costs
    }
}
