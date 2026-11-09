import Foundation

enum ForecastAvailability: Equatable {
    /// This site doesn't use the automatic forecast, so there is none to add.
    case none
    case loading
    /// Connected, but the forecast comparison can't run; carries a one-sentence reason.
    case unusable(String)
    /// Automatic setup is unavailable; the note opens solar forecast settings.
    case automaticUnavailable(String)
    case ready
}

enum SmartShiftChoiceID: Equatable, Hashable { case recommended, now }

struct SmartShiftChoice: Equatable {
    let id: SmartShiftChoiceID
    let label: String
    let price: String
    let caption: String
}

enum SmartShiftBadge: Equatable { case cheapest, priciest }

struct SmartShiftBarState: Equatable {
    let runKwh: Double
    let totalPosition: Double
    let runLabel: String?
    let total: String
    var badge: SmartShiftBadge?
    var badgeLabel: String?
    /// What tapping this bar says for this time.
    var explanation = ""
}

struct SmartShiftBar: Equatable {
    let periodKey: String
    let name: String
    let rate: String
    let buyRate: Double
    let baselinePosition: Double
    var recommended: SmartShiftBarState
    var now: SmartShiftBarState
    func state(for id: SmartShiftChoiceID) -> SmartShiftBarState { id == .now ? now : recommended }
}

struct SmartShiftSlot: Equatable {
    let periodKey: String
    let extraKwh: Double
    let label: String
    let accessibilityLabel: String
}

struct SmartShiftVerdict: Equatable {
    enum Note: Equatable {
        /// `usesHistory`: banks followed the site's last four weeks rather than holding still.
        case noForecast(usesHistory: Bool)
        case forecastState(String)
        case automaticForecast(String)
        case unobservedBalance
    }

    let title: String
    let subtitle: String
    /// The saving alone ("$0.42 cheaper"), for the navigation bar; nil when the headline claims none.
    let barSaving: String?
    let choices: [SmartShiftChoice]
    let chartTitle: String
    let chartSubtitle: String
    let rateBars: [SmartShiftBar]
    let slot: SmartShiftSlot?
    let why: String
    let notes: [Note]
}

/// One rate period in "How this is worked out".
struct PeriodRow: Equatable {
    let name: String
    let buy: String
    let sell: String
    /// "18 kWh banked", "6 kWh owed", "0 kWh" or "No bank yet".
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
    var projection: LoadTimingForecastEstimator.Projection.Kind?
}

/// Every Smart Shift sentence and display decision, kept out of the views so it can be tested.
