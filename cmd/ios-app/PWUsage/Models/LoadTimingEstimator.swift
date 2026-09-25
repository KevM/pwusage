import Foundation

struct LoadTimingEstimator {
    enum Verdict: Equatable {
        case covered
        case tight
        case partial
        case bought
        case unknown
    }

    struct Pricing: Equatable {
        let surplusKwh: Double
        let buyRate: Double
        let sellRate: Double
    }

    struct Cost: Equatable {
        let total: Double?
        let coveredKwh: Double
        let boughtKwh: Double
        let verdict: Verdict
    }

    struct Profile: Equatable, Identifiable {
        let id: String
        let label: String
        let kwh: Double
        let headroomKwh: Double
    }

    static let profiles: [Profile] = [
        .init(id: "car-large", label: "Big car", kwh: 100, headroomKwh: 160),
        .init(id: "car-small", label: "Little car", kwh: 60, headroomKwh: 100),
        .init(id: "laundry", label: "Laundry", kwh: 8, headroomKwh: 20),
        .init(id: "dishwasher", label: "Dishwasher", kwh: 5, headroomKwh: 5),
    ]

    static func costToRun(_ loadKwh: Double, pricing: Pricing?, headroomKwh: Double? = nil) -> Cost {
        guard let pricing,
              loadKwh.isFinite, loadKwh >= 0,
              pricing.surplusKwh.isFinite,
              pricing.buyRate.isFinite,
              pricing.sellRate.isFinite else {
            return Cost(total: nil, coveredKwh: 0, boughtKwh: 0, verdict: .unknown)
        }
        guard pricing.buyRate != 0 || pricing.sellRate != 0 else {
            return Cost(total: nil, coveredKwh: 0, boughtKwh: 0, verdict: .unknown)
        }

        let covered = min(loadKwh, max(pricing.surplusKwh, 0))
        let bought = loadKwh - covered
        let total = covered * pricing.sellRate + bought * pricing.buyRate
        let verdict: Verdict
        if covered == 0 {
            verdict = .bought
        } else if bought > 0 {
            verdict = .partial
        } else if let headroomKwh, pricing.surplusKwh < headroomKwh {
            verdict = .tight
        } else {
            verdict = .covered
        }
        return Cost(total: total, coveredKwh: covered, boughtKwh: bought, verdict: verdict)
    }

    static func customAmount(_ amount: Double) -> Double {
        guard amount.isFinite else { return 1 }
        return min(max(amount, 1), 100)
    }

    static func profile(forHeadroom surplusKwh: Double) -> Profile? {
        profiles.first { surplusKwh >= $0.headroomKwh }
    }
}
