import Foundation
@testable import PWUsage

/// Versioned, fully serializable inputs. Keep the PRNG stable so seed reports remain replayable.
struct SmartShiftScenario: Codable {
    var version = 1
    let seed: UInt64
    var mode: Int // 0 flat, 1 history, 2 forecast + history, 3 forecast without history
    var now: Date
    var age: Double
    var billHours: Double
    var zone: String
    var energy: Double
    var duration: Double
    var balances: [Double]
    var buys: [Double]
    var sells: [Double]
    var grid: Double
    var dullGrid: Double
    var home: Double
    var battery: Double
    var solar: Double
    var dullSolar: Double
    var forecastHours: Double

    init(seed: UInt64) {
        self.seed = seed
        var random = Generator(state: seed)
        mode = Int(seed % 4)
        let dates = ["2026-03-08T06:00:00Z", "2026-11-01T05:00:00Z", "2028-02-29T23:00:00Z", "2026-10-31T23:45:00Z"]
        now = ISO8601DateFormatter().date(from: random.pick(dates))!
        zone = random.pick(["UTC", "America/Chicago", "Australia/Lord_Howe", "Asia/Kathmandu"])
        age = random.pick([0, 299, 300, 301, 900, 1800])
        duration = random.pick([0.25, 0.5, 1, 1.75, 3, 12])
        billHours = random.pick([duration, duration + 1.0 / 3600, 24, 72, 168, 168 + 1.0 / 3600, 240])
        energy = random.pick([0.01, 1, 3, 3.000001, 8, 20])
        balances = (0 ..< 2).map { _ in random.pick([-20, -3.000001, -3, -2.999999, 0, 1, 3, 20, 200]) }
        buys = (0 ..< 2).map { _ in random.pick([-0.05, 0, 0.10, 0.30, 0.80]) }
        sells = (0 ..< 2).map { _ in random.pick([-0.02, 0, 0.04, 0.20, 0.90]) }
        grid = random.pick([-2, -0.1, 0, 0.1, 3])
        dullGrid = grid - random.pick([0, 0.1, 1, 3])
        home = random.pick([0, 0.3, 2])
        battery = random.pick([-2, 0, 1])
        solar = random.pick([0, 0.5, 4, 8])
        dullSolar = solar * random.pick([0, 0.5, 1])
        forecastHours = max(duration, random.pick([1, 12, 48, 168, 192]))
    }

    var profile: LoadProfile {
        .init(id: "fuzz", name: "Fuzz job", kind: .appliance, energyKwh: energy, durationHours: duration, carSettings: nil)
    }
    var source: Date { now.addingTimeInterval(-age) }
    var projectionStart: Date { min(now, source.addingTimeInterval(300)) }
    var billEnd: Date { now.addingTimeInterval(billHours * 3600) }
    var tomorrowEnd: Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: now))!
    }
    var expectedEnd: Date {
        mode == 3 ? min(billEnd, tomorrowEnd, now.addingTimeInterval(forecastHours * 3600)) : billEnd
    }
    var tariffs: [LoadTimingTariffSegment] {
        // Alternating, repeating banks; the first interval includes the observed sample.
        stride(from: -6, to: 246, by: 6).enumerated().map { index, hour in
            let bank = index % 2
            return .init(start: now.addingTimeInterval(Double(hour) * 3600),
                         end: now.addingTimeInterval(Double(hour + 6) * 3600),
                         periodKey: "p\(bank)", name: "p\(bank)", buyRate: buys[bank], sellRate: sells[bank])
        }
    }
    var forecast: [SolarForecastInterval] {
        // With history, deliberately leave a gap after the observed sample and before now.
        [.init(periodStart: mode == 3 ? projectionStart : now,
               periodEnd: now.addingTimeInterval(forecastHours * 3600), powerKw: solar, cautiousPowerKw: dullSolar)]
    }
    var projection: LoadTimingForecastEstimator.Projection {
        let context = LoadTimingForecastEstimator.PlanningContext(timeZone: zone,
                                                                  slots: stride(from: 0, to: 1440, by: 30).map {
                                                                      .init(localMinute: $0, homeKw: home, batteryNetChargeKw: battery,
                                                                            gridNetExportKw: mode == 3 ? nil : grid, cautiousGridNetExportKw: mode == 3 ? nil : dullGrid)
                                                                  }, asOf: now)
        switch mode {
        case 0: return .flat(timeZone: zone)
        case 1: return .history(context: context)
        default: return .forecast(intervals: forecast, context: context)
        }
    }
    func evaluate(reversed: Bool = false, projection override: LoadTimingForecastEstimator.Projection? = nil,
                  segments: [LoadTimingTariffSegment]? = nil) -> LoadTimingForecastEstimator.Result {
        let periods = (0 ..< 2).map { bank in
            LoadTimingPeriod(name: "p\(bank)", marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: balances[bank],
                             isActive: false, nextStartPhrase: nil, buyRate: buys[bank], sellRate: sells[bank])
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments ?? (reversed ? tariffs.reversed() : tariffs),
                                nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        return LoadTimingForecastEstimator.evaluate(profile: profile, now: now, timing: timing, projection: override ?? projection,
                                                    balanceSourceTime: source, billingCycleEnd: billEnd, currencyCode: "USD")
    }
    var diagnostic: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? String(bytes: encoder.encode(self), encoding: .utf8)) ?? "seed=\(seed)"
    }

    private struct Generator {
        var state: UInt64
        mutating func pick<T>(_ values: [T]) -> T {
            state = state &+ 0x9e3779b97f4a7c15
            var value = state
            value = (value ^ (value >> 30)) &* 0xbf58476d1ce4e5b9
            value = (value ^ (value >> 27)) &* 0x94d049bb133111eb
            value ^= value >> 31
            return values[Int(value % UInt64(values.count))]
        }
    }
}

/// Independent accounting oracle: direct interval overlaps, no production integration,
/// pricing, candidate generation, or safety helpers. Constant context is intentional:
/// exact integrals are simple enough to audit, including forecast/history handoff.
struct SmartShiftReference {
    let scenario: SmartShiftScenario

    func overlap(_ a: Date, _ b: Date, _ c: Date, _ d: Date) -> Double {
        max(0, min(b, d).timeIntervalSince(max(a, c))) / 3600
    }
    func baseline(until end: Date, cautious: Bool = false) -> [Double] {
        let s = scenario
        var result = s.balances
        if s.mode == 0 { return result }
        let history = cautious ? s.grid + (s.dullGrid - s.grid) / sqrt(7) : s.grid
        let sun = cautious ? s.solar + (s.dullSolar - s.solar) * (0.6745 / 1.2816) / sqrt(7) : s.solar
        for tariff in s.tariffs {
            let bank = tariff.periodKey == "p0" ? 0 : 1
            let hours = overlap(tariff.start, tariff.end, s.projectionStart, end)
            var forecastHours = 0.0
            if s.mode >= 2 {
                let start = max(s.projectionStart, s.forecast[0].periodStart)
                let cutoff = s.mode == 3 ? s.forecast[0].periodEnd : min(s.forecast[0].periodEnd, s.now.addingTimeInterval(7 * 86400))
                forecastHours = overlap(tariff.start, tariff.end, start, min(end, cutoff))
            }
            result[bank] += (hours - forecastHours) * history + forecastHours * (sun - s.home - s.battery)
        }
        return result
    }
    func draws(start: Date, until cutoff: Date) -> [Double] {
        let s = scenario
        var result = [0.0, 0.0]
        for tariff in s.tariffs {
            let bank = tariff.periodKey == "p0" ? 0 : 1
            result[bank] += overlap(tariff.start, tariff.end, start, min(start.addingTimeInterval(s.duration * 3600), cutoff)) * s.energy / s.duration
        }
        return result
    }
    func cost(start: Date) -> Double {
        let s = scenario
        let base = baseline(until: s.expectedEnd)
        let used = draws(start: start, until: s.expectedEnd)
        // Bill change by the exported and imported kWh displaced by the job.
        return (0 ..< 2).reduce(0) { total, bank in
            let exportLost = max(0, base[bank]) - max(0, base[bank] - used[bank])
            let importAdded = max(0, used[bank] - base[bank]) - max(0, -base[bank])
            return total + exportLost * s.sells[bank] + importAdded * s.buys[bank]
        }
    }
    func shortfall(start: Date) -> Double {
        let s = scenario
        // Older-server forecasts intentionally preserve the pre-safety-rule behavior.
        if s.mode == 0 || s.mode == 3 { return 0 }
        let end = min(s.expectedEnd, s.now.addingTimeInterval(7 * 86400))
        let typical = baseline(until: s.expectedEnd)
        let cautious = baseline(until: end, cautious: true)
        let full = draws(start: start, until: s.expectedEnd)
        let early = draws(start: start, until: end)
        return (0 ..< 2).filter { typical[$0] > 1e-9 && full[$0] > 0 }.map {
            max(0, min(early[$0], typical[$0]) - cautious[$0])
        }.max() ?? 0
    }
}
