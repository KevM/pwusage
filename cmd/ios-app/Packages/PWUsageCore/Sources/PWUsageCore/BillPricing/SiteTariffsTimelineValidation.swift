import Foundation

extension SiteTariffsTimelineResponse {
    /// Rejects a timeline for another site, an old version, an unknown time zone or a non-finite rate.
    public func validating(siteID: String) throws -> Self {
        let allPeriods = periods + referencePeriods
        let ratesAreFinite = allPeriods.allSatisfy { period in
            period.seasons.allSatisfy { season in
                let windows = season.weekdayPeriods + season.weekendPeriods
                return windows.allSatisfy { $0.buyRate.isFinite && $0.sellRate.isFinite }
            }
        }
        let batteryValid = battery.map {
            $0.nameplateEnergyWh.isFinite && $0.nameplatePowerW.isFinite && $0.backupReservePercent.isFinite
        } ?? true
        guard version == 2,
              siteId == siteID,
              TimeZone(identifier: timezone) != nil,
              ratesAreFinite,
              batteryValid else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }

    public func activePeriodNow(at now: Date = .now) -> ActiveTariffPeriodMatch? {
        RatePeriodResolver(timeline: self)?.match(at: now)
    }
}

/// A conditional timeline fetch: unchanged, or a new timeline with its ETag.
public enum TimelineFetch: Equatable, Sendable {
    case unchanged
    case changed(SiteTariffsTimelineResponse, etag: String?)
}
