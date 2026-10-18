import Foundation

/// Everything one Smart Shift pass priced, and what it concluded, as JSON the
/// owner can paste into a debugging chat. It carries every input
/// `LoadTimingForecastEstimator` needs, so `replay()` re-runs the pass offline.
///
/// It never carries a credential: the Solcast key and resource IDs, cookies and
/// tokens are not inputs to the estimator, and nothing here is handed them.
struct SmartShiftDiagnostics: Codable, Equatable {
    typealias Estimator = LoadTimingForecastEstimator

    static let currentSchemaVersion = 1

    struct App: Codable, Equatable {
        let version: String
        let build: String

        /// This build's marketing version and build number, from its Info.plist.
        static var current: App {
            let info = Bundle.main.infoDictionary ?? [:]
            return App(version: info["CFBundleShortVersionString"] as? String ?? "unknown",
                       build: info["CFBundleVersion"] as? String ?? "unknown")
        }
    }

    /// `ForecastAvailability` as a flat state name plus the card's one-sentence note.
    struct Availability: Codable, Equatable {
        let state: String
        let note: String?

        init(_ availability: ForecastAvailability) {
            switch availability {
            case .none: (state, note) = ("none", nil)
            case .loading: (state, note) = ("loading", nil)
            case .unusable(let reason): (state, note) = ("unusable", reason)
            case .ready: (state, note) = ("ready", nil)
            }
        }
    }

    /// The device's Solcast bookkeeping when the copy was made. Built from the
    /// cached batch's intervals and fetch time only: its credential and
    /// resource IDs are deliberately left behind.
    struct SolarForecast: Codable, Equatable {
        struct Budget: Codable, Equatable {
            let utcDay: Date
            let automaticAttempts: Int
            let automaticLimit: Int
            let totalAttempts: Int
            let totalLimit: Int
            let deferredUntil: Date?
        }

        let connection: String
        let state: String
        let unavailableReason: String?
        let fetchedAt: Date?
        let ageMinutes: Double?
        let intervalCount: Int
        let firstPeriodStart: Date?
        let lastPeriodStart: Date?
        let cautiousIntervalCount: Int
        let hasCautiousPowerKw: Bool
        /// `SolarForecastStore.isRecommendationUsable`: fresh enough, and the scope hasn't failed.
        let recommendationUsable: Bool
        let budget: Budget?
        let lastErrorDescription: String?
        let lastRefreshResult: String?
        let unavailableCause: String?

        init(batch: SolarForecastBatch?, now: Date, recommendationUsable: Bool, budget: SolarForecastBudget?,
             lastErrorDescription: String?, lastRefresh: SolarForecastRefreshResult?,
             unavailableCause: SolarForecastUnavailableCause?, connection: SolarForecastConnectionState,
             state: SolarForecastEnhancementState, unavailableReason: SolarForecastEnhancementUnavailableReason?) {
            self.connection = "\(connection)"
            self.state = "\(state)"
            self.unavailableReason = unavailableReason.map { "\($0)" }
            fetchedAt = batch?.fetchedAt
            ageMinutes = batch.map { (now.timeIntervalSince($0.fetchedAt) / 60 * 10).rounded() / 10 }
            let intervals = batch?.intervals ?? []
            intervalCount = intervals.count
            firstPeriodStart = intervals.first?.periodStart
            lastPeriodStart = intervals.last?.periodStart
            cautiousIntervalCount = intervals.filter { $0.cautiousPowerKw != nil }.count
            hasCautiousPowerKw = cautiousIntervalCount > 0
            self.recommendationUsable = recommendationUsable
            self.budget = budget.map {
                Budget(utcDay: $0.utcDay, automaticAttempts: $0.automaticAttempts,
                       automaticLimit: SolarForecastStore.automaticAttemptsPerUTCDay, totalAttempts: $0.totalAttempts,
                       totalLimit: SolarForecastStore.totalAttemptsPerUTCDay, deferredUntil: $0.deferredUntil)
            }
            self.lastErrorDescription = lastErrorDescription
            lastRefreshResult = lastRefresh.map { result in
                if case .failed(let failure) = result { return "failed(\(failure))" }
                return "\(result)"
            }
            self.unavailableCause = unavailableCause.map { "\($0)" }
        }
    }

    struct Outcome: Codable, Equatable {
        let comparison: Estimator.Comparison?
        let unavailableReason: Estimator.UnavailableReason?
    }

    var schemaVersion = Self.currentSchemaVersion
    let capturedAt: Date
    let app: App?
    let siteId: String
    let job: LoadProfile
    let now: Date
    let balanceSourceTime: Date?
    let billingCycleEnd: Date
    let currencyCode: String
    let timeZone: String
    let loadTiming: LoadTiming
    /// The projection that priced `result`; `nil` when none could run.
    let projection: Estimator.Projection.Kind?
    let forecastAvailability: Availability
    let forecastFetchedAt: Date?
    /// The forecast and planning context the pass was offered, whichever projection used them.
    let forecastIntervals: [SolarForecastInterval]?
    let planningContext: Estimator.PlanningContext?
    let result: Outcome
    /// Added when the copy is made, since reading the store is asynchronous.
    var solarForecast: SolarForecast? = nil

    init(siteId: String, app: App?, job: LoadProfile, now: Date, balanceSourceTime: Date?, billingCycleEnd: Date,
         currencyCode: String, timeZone: String, timing: LoadTiming, evaluation: SmartShiftEvaluation,
         intervals: [SolarForecastInterval]?, context: Estimator.PlanningContext?, forecastFetchedAt: Date?,
         capturedAt: Date? = nil) {
        self.capturedAt = capturedAt ?? now
        self.app = app
        self.siteId = siteId
        self.job = job
        self.now = now
        self.balanceSourceTime = balanceSourceTime
        self.billingCycleEnd = billingCycleEnd
        self.currencyCode = currencyCode
        self.timeZone = timeZone
        self.loadTiming = timing
        self.projection = evaluation.projection
        self.forecastAvailability = Availability(evaluation.forecast)
        self.forecastFetchedAt = forecastFetchedAt
        self.forecastIntervals = intervals
        self.planningContext = context
        self.result = Outcome(comparison: evaluation.result.comparison, unavailableReason: evaluation.result.unavailableReason)
    }

    /// Re-runs the recorded projection on the recorded inputs; `nil` when they can't rebuild it.
    func replay() -> Estimator.Result? {
        guard let balanceSourceTime, let projection = rebuiltProjection() else { return nil }
        return Estimator.evaluate(profile: job, now: now, timing: loadTiming, projection: projection,
                                  balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                  currencyCode: currencyCode)
    }

    private func rebuiltProjection() -> Estimator.Projection? {
        switch projection {
        case .forecast:
            guard let forecastIntervals, let planningContext else { return nil }
            return .forecast(intervals: forecastIntervals, context: planningContext)
        case .history:
            return planningContext.map { .history(context: $0) }
        case .flat:
            return .flat(timeZone: timeZone)
        case nil:
            return nil
        }
    }

    /// Pretty, key-sorted JSON with UTC ISO 8601 dates. Non-finite numbers are
    /// written as strings rather than failing the copy, since they are exactly
    /// what a debugging session would want to see.
    func json() throws -> String {
        let data = try Self.encoder().encode(self)
        return String(decoding: data, as: UTF8.self)
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(timestampFormatter().string(from: date))
        }
        encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity",
                                                                      negativeInfinity: "-Infinity", nan: "NaN")
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = timestampFormatter().date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 timestamp: \(value)")
            }
            return date
        }
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity",
                                                                        negativeInfinity: "-Infinity", nan: "NaN")
        return decoder
    }

    private static func timestampFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }
}
