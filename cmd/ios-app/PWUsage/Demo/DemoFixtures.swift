import Foundation

/// The sample home behind demo mode and the App Store screenshots. Ships in
/// Release, so it carries no real site's name, IDs, utility or location.
///
/// Every builder is anchored to `asOf`, the real "now", and always tells the
/// same story whatever the real day or hour: On-peak is on, Off-peak starts in
/// three hours and is cheaper, and the bill cycle ends ten days from today.
/// The rates are a winter Time-of-Use plan; the clock times shown follow the
/// real clock, so Off-peak may read "starts at 2:15 AM".
enum DemoFixtures {
    static let site = MobileSite(id: "demo-home", name: "Cedar House", utility: "Hill Country Electric")
    static let timeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
    static let tariffName = "Residential · Time of use"
    /// The battery's live charge, which the simulated hold keeps.
    static let stateOfCharge = 64

    /// Typical winter solar for the hour of day, in kW. The planning history and
    /// the demo forecast share it, so Smart Shift and the bill project the same
    /// days: midday export bends the period banks, the evening draws them down.
    static func solarKw(hour: Int) -> Double {
        switch hour {
        case 8 ..< 10: 1.0
        case 10 ..< 15: 3.2
        case 15 ..< 17: 1.2
        default: 0
        }
    }

    private struct Rate {
        let name: String
        let buy: Double
        let sell: Double
    }

    private struct Segment {
        let start: Date
        let end: Date
        let rate: Rate
    }

    private struct Cycle {
        let start: Date
        let end: Date
    }

    /// Cumulative net grid import per period since the cycle start.
    private struct Usage {
        let onPeak: Double
        let offPeak: Double
        var cost: Double { onPeak * DemoFixtures.onPeak.buy + offPeak * DemoFixtures.offPeak.buy }
    }

    private static let onPeak = Rate(name: "On-peak", buy: 0.31, sell: 0.04)
    private static let offPeak = Rate(name: "Off-peak", buy: 0.10, sell: 0.03)
    /// Net grid import per whole day of the cycle. Both periods are net buyers,
    /// as a winter home is, so each period's marginal cost is its buy rate.
    /// The banks stay small (about 60 and 175 kWh owed) so a day's solar and
    /// evening load visibly move them, yet On-peak is deep enough that Smart
    /// Shift's two days never repay it.
    private static let onPeakKwhPerDay = 3.0
    private static let offPeakKwhPerDay = 8.0

    /// Whole seconds: a fractional source instant can serialize into the future.
    private static func source(_ asOf: Date) -> Date {
        Date(timeIntervalSince1970: floor(asOf.timeIntervalSince1970))
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static func cycle(_ asOf: Date) -> Cycle {
        let today = calendar.startOfDay(for: asOf)
        let end = calendar.date(byAdding: .day, value: 10, to: today) ?? today.addingTimeInterval(10 * 86400)
        let start = calendar.date(byAdding: .month, value: -1, to: end) ?? end.addingTimeInterval(-30 * 86400)
        return Cycle(start: start, end: end)
    }

    /// On-peak from the source instant for three hours, then Off-peak and
    /// On-peak in 12-hour turns until `end`. Starts exactly at the source
    /// instant, as production does: a later start collapses the estimator's
    /// horizon and the forecast never becomes available.
    private static func timeline(from start: Date, through end: Date) -> [Segment] {
        var segments = [Segment(start: start, end: min(start.addingTimeInterval(3 * 3600), end), rate: onPeak)]
        while let last = segments.last, last.end < end {
            let rate = last.rate.name == onPeak.name ? offPeak : onPeak
            segments.append(Segment(start: last.end, end: min(last.end.addingTimeInterval(12 * 3600), end), rate: rate))
        }
        return segments
    }

    /// Models cumulative energy with natural multi-day weather curvature across the cycle,
    /// so the recorded line on the bill outlook chart curves realistically rather than
    /// reading as a flat ruler line.
    private static func curvedElapsedDays(through date: Date, cycleStart: Date) -> Double {
        let elapsed = max(date.timeIntervalSince(cycleStart) / 86400, 0)
        guard elapsed > 0 else { return 0 }
        let omega1 = 2 * Double.pi / 6.0
        let omega2 = 2 * Double.pi / 3.5
        let primaryAmplitude = 0.5
        let secondaryAmplitude = 0.2
        return elapsed + (primaryAmplitude / omega1) * (1 - cos(omega1 * elapsed))
            + (secondaryAmplitude / omega2) * sin(omega2 * elapsed)
    }

    private static func usage(through date: Date, cycleStart: Date) -> Usage {
        let days = curvedElapsedDays(through: date, cycleStart: cycleStart)
        return Usage(onPeak: days * onPeakKwhPerDay, offPeak: days * offPeakKwhPerDay)
    }

    private static func cents(_ value: Double) -> Double { (value * 100).rounded() / 100 }

    private static func instantText(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func localDateText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// Decodes through the production decoder, so the demo meets the same
    /// contract a server response does.
    private static func decode<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
        try MobileContractDecoder.make().decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    static func live(asOf: Date) throws -> MobileLiveResponse {
        let source = source(asOf)
        let sourceText = instantText(source)
        let balance = -usage(through: source, cycleStart: cycle(source).start).onPeak
        // Solar covers the home and charges the battery; the rest is exported.
        return try decode(MobileLiveResponse.self, [
            "version": 1,
            "site": ["id": site.id, "name": site.name, "timezone": timeZone.identifier,
                     "localDate": localDateText(source)],
            "live": ["solarPower": 3900, "loadPower": 1400, "batteryPower": -1800, "gridPower": -700],
            "stateOfCharge": stateOfCharge,
            "activeTariff": tariffName,
            "activeLoadTiming": [
                "periodName": onPeak.name, "buyRate": onPeak.buy, "sellRate": onPeak.sell,
                "marginalCost": onPeak.buy, "basis": "buy", "balanceKwh": cents(balance),
                "energyDataThrough": sourceText],
            "today": ["homeKwh": 21.6, "solarKwh": 15.2, "gridNetKwh": 9.8, "batteryNetKwh": -3.4],
            "todayComplete": true,
            "sources": ["liveStatusAt": sourceText, "energyDataThrough": sourceText, "stateOfChargeAt": sourceText]])
    }

    private static func period(_ rate: Rate, balance: Double, isActive: Bool, nextStart: String) -> [String: Any] {
        ["name": rate.name, "marginalCost": rate.buy, "basis": "buy", "cycleNetExportKwh": cents(balance),
         "isActive": isActive, "nextStartPhrase": nextStart, "buyRate": rate.buy, "sellRate": rate.sell]
    }

    static func bill(asOf: Date) throws -> MobileBillResponse {
        let source = source(asOf)
        let sourceText = instantText(source)
        let cycle = cycle(source)
        let used = usage(through: source, cycleStart: cycle.start)
        let dateFormatter = ISO8601DateFormatter()
        let timeline = timeline(from: source, through: source.addingTimeInterval(7 * 86400)).map { segment in
            ["start": instantText(segment.start), "end": instantText(segment.end), "periodKey": segment.rate.name,
             "name": segment.rate.name, "buyRate": segment.rate.buy, "sellRate": segment.rate.sell] as [String: Any]
        }
        let periods = [
            period(onPeak, balance: -used.onPeak, isActive: true, nextStart: "in 15 hours"),
            period(offPeak, balance: -used.offPeak, isActive: false, nextStart: "in 3 hours")]
        let loadTiming: [String: Any] = [
            "hasTariff": true, "hasCycleData": true, "activeIsCheapest": false,
            "periods": periods, "pricingPeriods": periods, "tariffTimeline": timeline,
            "nextCheaper": ["name": offPeak.name, "marginalCost": offPeak.buy, "phrase": "in 3 hours"],
            "nextCheaperPhrase": "Wait until Off-peak in 3 hours",
            "nextStartPhraseByKey": [onPeak.name: "in 15 hours", offPeak.name: "in 3 hours"]]
        let billPeriods: [[String: Any]] = [
            ["tariffName": tariffName, "periodName": offPeak.name, "netGridKwh": cents(used.offPeak),
             "cost": cents(used.offPeak * offPeak.buy)],
            ["tariffName": tariffName, "periodName": onPeak.name, "netGridKwh": cents(used.onPeak),
             "cost": cents(used.onPeak * onPeak.buy)]]
        var response = try decode(MobileBillResponse.self, [
            "version": 1,
            "site": ["id": site.id, "name": site.name, "timezone": timeZone.identifier],
            "currentBill": [
                "estimatedCost": cents(used.cost), "currency": "USD",
                "cycleStart": dateFormatter.string(from: cycle.start),
                "cycleEnd": dateFormatter.string(from: cycle.end),
                "periods": billPeriods],
            "loadTiming": loadTiming,
            "sources": ["calculatedAt": sourceText, "energyDataThrough": sourceText]])
        response.outlook = outlook(source: source, cycle: cycle)
        return response
    }

    /// Daily cumulative points from the cycle start, ending on the source
    /// instant, with no missing days, so the Bill tab can project to the end.
    private static func outlook(source: Date, cycle: Cycle) -> BillOutlookHistory {
        var dates: [Date] = []
        var day = calendar.date(byAdding: .day, value: 1, to: cycle.start) ?? source
        while day < source {
            dates.append(day)
            day = calendar.date(byAdding: .day, value: 1, to: day) ?? source
        }
        dates.append(source)
        let points = dates.map { date in
            let used = usage(through: date, cycleStart: cycle.start)
            return BillOutlook.point(date: date, buckets: [
                .init(tariffName: tariffName, periodName: onPeak.name, netGridKwh: used.onPeak,
                      buyRate: onPeak.buy, sellRate: onPeak.sell),
                .init(tariffName: tariffName, periodName: offPeak.name, netGridKwh: used.offPeak,
                      buyRate: offPeak.buy, sellRate: offPeak.sell)])
        }
        let tariffs = timeline(from: source, through: cycle.end).map { segment in
            BillOutlookTariff(start: segment.start, end: segment.end, periodKey: segment.rate.name,
                              name: segment.rate.name, buyRate: segment.rate.buy, sellRate: segment.rate.sell,
                              tariffName: tariffName, periodName: segment.rate.name)
        }
        return BillOutlookHistory(points: points, observedThrough: source, complete: true, tariffTimeline: tariffs)
    }

    /// Two weeks of an evening-peaked household: a morning bump, a quiet day,
    /// and most of the load from 5 PM to 9 PM, under a winter solar curve. The
    /// grid columns let the Bill tab project past the solar forecast.
    static func planningContext(asOf: Date) -> MobileLoadPlanningContextResponse {
        let source = source(asOf)
        let slots = (0 ..< 48).map { index in
            let hour = index / 2
            let homeKw: Double = switch hour {
            case 6 ..< 9: 1.2
            case 9 ..< 17: 0.7
            case 17 ..< 21: 2.4
            case 21 ..< 23: 1.1
            default: 0.5
            }
            let solarKw = solarKw(hour: hour)
            var slot = MobileLoadPlanningContextResponse.Slot(
                localMinute: index * 30, homeKw: homeKw, batteryNetChargeKw: 0, sampleCount: 12, coverage: 1
            )
            slot.solarKw = solarKw
            slot.gridNetExportKw = solarKw - homeKw
            slot.cautiousGridNetExportKw = solarKw * 0.6 - homeKw
            return slot
        }
        return MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: site.id, timezone: timeZone.identifier),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: source,
            availability: .available,
            unavailableReason: nil,
            usableDayCount: 14,
            historyStart: source.addingTimeInterval(-14 * 86400),
            historyEnd: source.addingTimeInterval(-86400),
            slots: slots
        )
    }

    static func tariffs(asOf _: Date) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2,
            siteId: site.id,
            timezone: timeZone.identifier,
            currency: "USD",
            periods: [demoCurrentPeriod(), demoPriorPeriod()],
            reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: 10,
                latestTariffName: tariffName,
                latestUpdatedAt: "2025-01-01T00:00:00Z",
                activeManualUpdatedAt: nil,
                differsFromActiveManual: false
            )
        )
    }

    private static func demoCurrentPeriod() -> TariffPeriodDTO {
        let peakWindow = demoWindow(.onPeak, startHour: 8, endHour: 20, buy: onPeak.buy, sell: onPeak.sell)
        let offPeakWindow = demoWindow(.offPeak, startHour: 20, endHour: 8, buy: offPeak.buy, sell: offPeak.sell)
        let weekendOffPeak = demoWindow(.offPeak, startHour: 0, endHour: 24, buy: offPeak.buy, sell: offPeak.sell)
        return TariffPeriodDTO(
            periodId: 2,
            tariffId: 20,
            name: tariffName,
            version: 1,
            source: .manual,
            effectiveFrom: "2026-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: TariffUpdatedByDTO(email: nil, isCurrentUser: true),
            seasons: [
                TariffSeasonInput(
                    name: "All year",
                    fromMonth: 1,
                    toMonth: 12,
                    weekdayPeriods: [peakWindow, offPeakWindow],
                    weekendPeriods: [weekendOffPeak]
                )
            ]
        )
    }

    private static func demoPriorPeriod() -> TariffPeriodDTO {
        let priorWindow = demoWindow(.offPeak, startHour: 0, endHour: 24, buy: 0.145, sell: 0.03)
        return TariffPeriodDTO(
            periodId: 1,
            tariffId: 10,
            name: tariffName,
            version: 1,
            source: .tesla,
            effectiveFrom: "2025-01-01",
            effectiveTo: "2025-12-31",
            isCurrentToday: false,
            updatedBy: nil,
            seasons: [
                TariffSeasonInput(
                    name: "All year",
                    fromMonth: 1,
                    toMonth: 12,
                    weekdayPeriods: [priorWindow],
                    weekendPeriods: [priorWindow]
                )
            ]
        )
    }

    private static func demoWindow(
        _ name: TariffPeriodName,
        startHour: Int,
        endHour: Int,
        buy: Double,
        sell: Double
    ) -> TimePeriodWindowInput {
        TimePeriodWindowInput(
            touName: name,
            fromHour: startHour,
            fromMinute: 0,
            toHour: endHour,
            toMinute: 0,
            buyRate: buy,
            sellRate: sell
        )
    }
}
