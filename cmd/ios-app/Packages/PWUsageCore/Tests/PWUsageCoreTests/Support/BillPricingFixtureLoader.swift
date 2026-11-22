import Foundation
@testable import PWUsageCore

/// Server-generated bill-pricing parity fixture from `PWUsageTests/Fixtures/BillPricing/`.
struct BillPricingFixture: Decodable {
    let name: String
    let now: Date
    let billingDay: Int
    let timeline: SiteTariffsTimelineResponse
    let days: [Day]
    let expected: Expected

    struct Day: Decodable {
        let day: String
        let dayStart: Date
        let solarWh: [Float?]
        let loadWh: [Float?]
        let gridWh: [Float?]

        func asEnergyFlowDay() -> EnergyFlowDay {
            let empty = [Float?](repeating: nil, count: gridWh.count)
            return EnergyFlowDay(
                day: day,
                dayStart: dayStart,
                solarWh: solarWh,
                loadWh: loadWh,
                gridWh: gridWh,
                batteryWh: empty,
                batterySoc: empty
            )
        }
    }

    struct Expected: Decodable {
        let currentBill: CurrentBill
        let outlook: Outlook?
        let loadTiming: LoadTiming?
    }

    struct Outlook: Decodable {
        let points: [BillOutlookPoint]
        let observedThrough: Date
        let complete: Bool
    }

    struct CurrentBill: Decodable {
        let estimatedCost: Double?
        let cycleStart: Date
        let cycleEnd: Date
        let periods: [ExpectedPeriod]
    }

    struct ExpectedPeriod: Decodable, Equatable {
        let tariffName: String
        let periodName: String
        let netGridKwh: Double
        let cost: Double
    }

    static let allNames: [String] = [
        "billing-day-31-february",
        "dst-fall-back",
        "dst-spring-forward",
        "gapped-day",
        "holiday-weekday",
        "no-plan",
        "plan-change-mid-cycle",
        "season-boundary-mid-month",
        "single-plan-cycle",
        "uncovered-window"
    ]

    static func load(_ name: String) throws -> BillPricingFixture {
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "Fixtures/BillPricing"
        ) else {
            throw LoadError.missingResource(name)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFraction.date(from: text) {
                return date
            }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: text) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO 8601 date \(text)"
            )
        }
        return try decoder.decode(BillPricingFixture.self, from: Data(contentsOf: url))
    }

    enum LoadError: Error, Equatable {
        case missingResource(String)
    }
}
