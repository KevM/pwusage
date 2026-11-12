import Foundation

enum TariffSource: String, Codable, Equatable, Sendable {
    case tesla
    case manual
}

enum TariffPeriodName: String, Codable, Equatable, Sendable, CaseIterable, Hashable {
    // Declared in Tesla's order (cheapest first), which is also the picker order.
    case superOffPeak = "SUPER_OFF_PEAK"
    case offPeak = "OFF_PEAK"
    case partialPeak = "PARTIAL_PEAK"
    case onPeak = "ON_PEAK"

    var displayName: String {
        switch self {
        case .onPeak: "Peak"
        case .partialPeak: "Mid-Peak"
        case .offPeak: "Off-Peak"
        case .superOffPeak: "Super Off-Peak"
        }
    }
}

struct TimePeriodWindowInput: Codable, Equatable, Sendable, Hashable {
    let touName: TariffPeriodName
    let fromHour: Int
    let fromMinute: Int
    let toHour: Int
    let toMinute: Int
    let buyRate: Double
    let sellRate: Double
}

struct TariffSeasonInput: Codable, Equatable, Sendable, Hashable {
    let name: String
    let fromMonth: Int
    let toMonth: Int
    let weekdayPeriods: [TimePeriodWindowInput]
    let weekendPeriods: [TimePeriodWindowInput]
}

struct TariffUpdatedByDTO: Codable, Equatable, Sendable {
    let email: String?
    let isCurrentUser: Bool
}

struct TariffPeriodDTO: Codable, Equatable, Sendable, Identifiable {
    let periodId: Int
    let tariffId: Int
    let name: String
    let version: Int
    let source: TariffSource
    let effectiveFrom: String
    let effectiveTo: String?
    let isCurrentToday: Bool
    let updatedBy: TariffUpdatedByDTO?
    let seasons: [TariffSeasonInput]

    var id: Int { periodId }
}

struct TeslaSyncDTO: Codable, Equatable, Sendable {
    let latestTariffId: Int?
    let latestTariffName: String?
    let latestUpdatedAt: String?
    /// When the active custom plan was saved; nil from servers that predate the field.
    let activeManualUpdatedAt: String?
    let differsFromActiveManual: Bool
}

/// What to tell the user when their custom plan and the Tesla plan disagree.
struct TeslaDivergenceCopy: Equatable, Sendable {
    let title: String
    let detail: String

    init(sync: TeslaSyncDTO) {
        let ours = Self.parse(sync.activeManualUpdatedAt)
        let theirs = Self.parse(sync.latestUpdatedAt)
        let planName = sync.latestTariffName.flatMap { $0.isEmpty ? nil : "\"\($0)\"" } ?? "Its plan"
        func day(_ date: Date) -> String {
            date.formatted(.dateTime.month(.abbreviated).day().year().locale(Locale(identifier: "en_US")))
        }
        if let ours, let theirs, ours >= theirs {
            title = "Your custom plan is newer than Tesla's"
            detail = "\(planName) in your Tesla account hasn't changed since \(day(theirs))."
        } else if let ours, let theirs {
            title = "Tesla changed its plan after your custom plan"
            detail = "\(planName) was updated in your Tesla account on \(day(theirs)); yours was saved \(day(ours))."
        } else {
            title = "Tesla's plan differs from your custom plan"
            detail = "\(planName) is saved in your Tesla account."
        }
    }

    /// Syncing often changes nothing on screen, so say what it found.
    static func syncNotice(previousTeslaPlan: Int?, refreshed: SiteTariffsTimelineResponse) -> String {
        let hasActiveCustomPlan = refreshed.teslaSync.differsFromActiveManual
        if refreshed.teslaSync.latestTariffId != previousTeslaPlan {
            return hasActiveCustomPlan
                ? "Saved Tesla's updated plan to your history. Your custom plan stays active."
                : "Tesla's updated plan was saved to your history."
        }
        return hasActiveCustomPlan
            ? "Checked Tesla: its plan hasn't changed. Your custom plan stays active."
            : "Checked Tesla: your rate plan is up to date."
    }

    private static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? Date(value, strategy: .iso8601))
            ?? (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }
}

struct ActiveTariffPeriodMatch: Equatable, Sendable {
    let period: TariffPeriodDTO
    let season: TariffSeasonInput
    let window: TimePeriodWindowInput
}

struct SiteTariffsTimelineResponse: Codable, Equatable, Sendable {
    let version: Int
    let siteId: String
    let timezone: String
    let currency: String
    let periods: [TariffPeriodDTO]
    let reattribution: ReattributionStatusDTO?
    /// Observed holidays (site-local YYYY-MM-DD); they follow the weekend schedule. Nil from older servers.
    var holidayDates: [String]?
    let teslaSync: TeslaSyncDTO

    func validating(siteID: String) throws -> Self {
        let ratesAreFinite = periods.allSatisfy { period in
            period.seasons.allSatisfy { season in
                let allPeriods = season.weekdayPeriods + season.weekendPeriods
                return allPeriods.allSatisfy { $0.buyRate.isFinite && $0.sellRate.isFinite }
            }
        }
        guard version == 2, siteId == siteID, TimeZone(identifier: timezone) != nil, ratesAreFinite else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }

    func activePeriodNow(at now: Date = .now) -> ActiveTariffPeriodMatch? {
        guard let timeZone = TimeZone(identifier: timezone) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let comps = cal.dateComponents([.year, .month, .day, .weekday, .hour, .minute], from: now)
        guard let year = comps.year, let month = comps.month, let day = comps.day,
              let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else {
            return nil
        }
        let today = String(format: "%04d-%02d-%02d", year, month, day)
        guard let period = periods.first(where: {
            $0.effectiveFrom <= today && ($0.effectiveTo == nil || today <= ($0.effectiveTo ?? ""))
        }) else {
            return nil
        }
        guard let season = period.seasons.first(where: {
            Self.monthMatches(month, startMonth: $0.fromMonth, endMonth: $0.toMonth)
        }) else {
            return nil
        }
        let isWeekend = weekday == 1 || weekday == 7 || (holidayDates?.contains(today) ?? false)
        let windows = isWeekend ? season.weekendPeriods : season.weekdayPeriods
        let minuteOfDay = hour * 60 + minute
        guard let window = windows.first(where: { Self.windowMatches(minuteOfDay: minuteOfDay, window: $0) }) else {
            return nil
        }
        return ActiveTariffPeriodMatch(period: period, season: season, window: window)
    }

    private static func monthMatches(_ month: Int, startMonth: Int, endMonth: Int) -> Bool {
        if startMonth <= endMonth { return month >= startMonth && month <= endMonth }
        return month >= startMonth || month <= endMonth
    }

    private static func windowMatches(minuteOfDay: Int, window: TimePeriodWindowInput) -> Bool {
        let start = window.fromHour * 60 + window.fromMinute
        let end = window.toHour * 60 + window.toMinute
        if start == 0, end == 1440 || end == 0 { return true }
        if start < end { return minuteOfDay >= start && minuteOfDay < end }
        return minuteOfDay >= start || minuteOfDay < end
    }
}

struct RefreshTariffsResponse: Codable, Equatable, Sendable {
    let success: Bool
    let updatedFromTesla: Bool
    let timeline: SiteTariffsTimelineResponse
}

struct TariffPlanWriteRequest: Codable, Equatable, Sendable {
    let name: String
    let effectiveFrom: String
    let effectiveTo: String?
    let seasons: [TariffSeasonInput]

    private enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
        try container.encode(seasons, forKey: .seasons)
    }
}

enum EffectiveEndDatePatch: Equatable, Sendable {
    case unchanged
    case set(String?)
}

struct TariffPlanPatchRequest: Encodable, Equatable, Sendable {
    var name: String?
    var effectiveFrom: String?
    var effectiveTo: EffectiveEndDatePatch
    var seasons: [TariffSeasonInput]?

    init(
        name: String? = nil,
        effectiveFrom: String? = nil,
        effectiveTo: EffectiveEndDatePatch = .unchanged,
        seasons: [TariffSeasonInput]? = nil
    ) {
        self.name = name
        self.effectiveFrom = effectiveFrom
        self.effectiveTo = effectiveTo
        self.seasons = seasons
    }

    private enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let name { try container.encode(name, forKey: .name) }
        if let effectiveFrom { try container.encode(effectiveFrom, forKey: .effectiveFrom) }
        if case .set(let date) = effectiveTo {
            try container.encode(date, forKey: .effectiveTo)
        }
        if let seasons { try container.encode(seasons, forKey: .seasons) }
    }
}

@MainActor
protocol MobileTariffDataAPI: Sendable {
    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse
    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse
    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse
    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse
    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse
    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse
}
