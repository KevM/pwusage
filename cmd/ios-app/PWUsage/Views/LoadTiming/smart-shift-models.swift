import Foundation

enum ForecastAvailability: Equatable {
    /// No Solcast key on this device.
    case none
    case loading
    /// Connected, but the forecast comparison can't run; carries a one-sentence reason.
    case unusable(String)
    case ready
}

struct CostBar: Equatable {
    let label: String
    let amount: String
    let value: Double
    let isRecommended: Bool
}

/// A dashed rate-period switch on the chart, labelled "← Peak | Off-Peak →".
struct SwitchMarker: Equatable {
    let date: Date
    let label: String
    /// "← Peak": the period ending here, drawn just left of the line.
    let beforeLabel: String?
    /// "Off-Peak →": the period starting here, drawn just right of the line.
    let afterLabel: String?
}

/// One rate period's "energy weather" lane, from now to the end of the comparison.
struct LaneDisplay: Equatable {
    /// "Off-Peak bank (kWh)"
    let title: String
    /// "+18 kWh banked now", "−6 kWh owed now" or "0 kWh now"
    let startLabel: String
    let recommended: [LoadTimingForecastEstimator.BalancePoint]
    /// `nil` when the recommended start is now, so there is only one line.
    let startNow: [LoadTimingForecastEstimator.BalancePoint]?
    /// One label when both plans end at the same rounded value, else `[recommended, now]`.
    let endLabels: [String]
    let switches: [SwitchMarker]
}

struct SmartShiftVerdict: Equatable {
    enum Note: Equatable {
        /// `usesHistory`: banks followed the site's last four weeks rather than holding still.
        case connectSolcast(usesHistory: Bool)
        case forecastState(String)
        case unobservedBalance
    }

    let headline: String
    let barsCaption: String
    /// Recommended first; a single bar when the recommended start is now.
    let bars: [CostBar]
    /// "36% less"
    let percentLess: String?
    let why: String
    /// "Charge later"
    let laterLabel: String
    /// "Charge now"
    let nowLabel: String
    let lanes: [LaneDisplay]
    /// Clock times for the chart's x-axis: now, each run's end, and each switch.
    let axisDates: [Date]
    let notes: [Note]
    let accessibilitySummary: String
}

/// One rate period in "How this is worked out".
struct PeriodRow: Equatable {
    let name: String
    let buy: String
    let sell: String
    /// "+18 kWh banked", "−6 kWh owed", "0 kWh" or "No balance yet".
    let balance: String
}

/// One priced part of a run: energy from a bank (its credit given up) or bought (its buy rate).
struct CostLine: Equatable {
    let period: String
    /// "31.5 kWh from your bank × 4¢/kWh credit" or "21.2 kWh bought × 10¢/kWh"
    let detail: String
    let amount: String
}

/// What one start time adds to the bill, as arithmetic that sums to its cost bar.
struct CostBreakdown: Equatable {
    /// "Charge tomorrow at 4:30 PM" or "Charge now"
    let title: String
    let total: String
    let lines: [CostLine]
    /// Explains a bank the run uses that the forecast fills beyond today's balance.
    let notes: [String]
}

/// Points at another saved Job that waiting would save more on right now.
struct BetterJobHint: Equatable {
    let id: String
    let text: String
}

struct SmartShiftScreen: Equatable {
    enum Content: Equatable {
        case verdict(SmartShiftVerdict)
        /// The solar forecast is still loading and nothing fresh is on hand.
        case loading
        case blocked(String)
        case noJobs
    }

    let content: Content
}

/// The comparison the card shows, and what the forecast layer contributed to it.
struct SmartShiftEvaluation: Equatable {
    let result: LoadTimingForecastEstimator.Result
    let forecast: ForecastAvailability
    /// The projection that priced `result`; `nil` when none could run.
    var projection: LoadTimingForecastEstimator.Projection.Kind? = nil
}

/// Every Smart Shift sentence and display decision, kept out of the views so it can be tested.
