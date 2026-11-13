import Foundation
@testable import PWUsage

/// Research inputs for the solar degradation backtest. They live outside the repo, in the folder named
/// by PWUSAGE_SOLAR_BACKTEST_DIR (passed as TEST_RUNNER_PWUSAGE_SOLAR_BACKTEST_DIR=/abs/path to
/// ./run-tests.sh). The folder holds harrison.csv (timestamp,solar_wh), weather-daily.csv
/// (day,rain_mm,snow_cm), irradiance-hourly.csv (time,ghi,dni,dhi; UTC hour end), place.json
/// ({timezone, lat, lon}) and inputs.json (calibration and hold-out windows, `now`, manual layout).
/// See docs/plans/2026-11-13-solar-degradation-backtest.md.
struct DegradationBacktestInputs {
    static let environmentKey = "PWUSAGE_SOLAR_BACKTEST_DIR"
    static var isEnabled: Bool { ProcessInfo.processInfo.environment[environmentKey] != nil }

    struct Window: Decodable {
        let from: String
        let through: String

        func contains(_ day: String) -> Bool { day >= from && day <= through }
    }

    struct Config: Decodable {
        let calibration: Window
        let holdout: Window
        let now: Date
        let manual: ManualSolarLayout
    }

    private struct PlaceFile: Decodable {
        let timezone: String
        let lat: Double
        let lon: Double
    }

    struct Hour {
        /// End of the hour the radiation averages over.
        let end: Date
        let radiation: OpenMeteoArrayModel.Radiation
    }

    let directory: URL
    let config: Config
    let timeZone: TimeZone
    let latitude: Double
    let longitude: Double
    let samples: [(timestamp: Date, solarWh: Double)]
    let snowDays: Set<String>
    let rainDays: Set<String>
    let hours: [Hour]

    static func load() throws -> Self {
        guard let path = ProcessInfo.processInfo.environment[environmentKey] else {
            throw CocoaError(.fileNoSuchFile)
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let config = try decoder.decode(Config.self, from: Data(contentsOf: directory.appending(path: "inputs.json")))
        let place = try decoder.decode(PlaceFile.self, from: Data(contentsOf: directory.appending(path: "place.json")))
        guard let timeZone = TimeZone(identifier: place.timezone) else { throw CocoaError(.fileReadCorruptFile) }
        let weather = try rows(directory.appending(path: "weather-daily.csv"))
        return try Self(
            directory: directory, config: config, timeZone: timeZone, latitude: place.lat, longitude: place.lon,
            samples: samples(directory.appending(path: "harrison.csv")),
            snowDays: Set(weather.filter { (Double($0[2]) ?? 0) > 0 }.map { $0[0] }),
            rainDays: Set(weather.filter { (Double($0[1]) ?? 0) > 0 }.map { $0[0] }),
            hours: hours(directory.appending(path: "irradiance-hourly.csv")))
    }

    var location: SolarHomeLocation {
        SolarHomeLocation(latitude: latitude, longitude: longitude, source: .map)
    }

    func place(reference: SolarHealthReference) -> SolarHealthYearFit.Place {
        SolarHealthYearFit.Place(reference: reference, latitude: latitude, longitude: longitude, timeZone: timeZone)
    }

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    static func dayString(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    func write(_ lines: [String], to name: String) throws {
        try Data(lines.joined(separator: "\n").utf8).write(to: directory.appending(path: name))
    }

    private static func rows(_ url: URL) throws -> [[String]] {
        try String(contentsOf: url, encoding: .utf8).split(whereSeparator: \.isNewline).dropFirst().map {
            $0.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        }
    }

    private static func date(_ text: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: text) else { throw CocoaError(.fileReadCorruptFile) }
        return date
    }

    private static func samples(_ url: URL) throws -> [(timestamp: Date, solarWh: Double)] {
        let formatter = ISO8601DateFormatter()
        return try rows(url).map { fields in
            guard fields.count >= 2, let date = formatter.date(from: fields[0]), let energy = Double(fields[1]) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return (timestamp: date, solarWh: energy)
        }
    }

    private static func hours(_ url: URL) throws -> [Hour] {
        try rows(url).compactMap { fields in
            guard fields.count >= 4, let ghi = Double(fields[1]), let dni = Double(fields[2]),
                  let dhi = Double(fields[3]) else { return nil }
            return try Hour(end: date(fields[0]), radiation: .init(ghi: ghi, dni: dni, dhi: dhi))
        }
    }
}

/// One day's expected and measured energy (kWh) under one model.
struct DegradationDay {
    let day: String
    let expected: Double
    let actual: Double
}

/// Two observations of one calendar month and the annualized change between them (%/yr).
struct DegradationPair {
    let month: Int
    let earlier: SolarHealthMonthEntry
    let later: SolarHealthMonthEntry
    let change: Double
}

/// Daily expected-energy error for one model over a set of days.
struct DegradationDailyScore {
    let count: Int
    /// Mean absolute error, kWh.
    let mae: Double
    /// Mean of actual minus expected, kWh.
    let bias: Double
    let meanActual: Double

    init(_ days: [DegradationDay]) {
        count = days.count
        let denominator = Double(max(days.count, 1))
        mae = days.reduce(0) { $0 + abs($1.actual - $1.expected) } / denominator
        bias = days.reduce(0) { $0 + $1.actual - $1.expected } / denominator
        meanActual = days.reduce(0) { $0 + $1.actual } / denominator
    }

    /// Scores overall and per season, keyed "all" and by season name.
    static func scopes(_ days: [DegradationDay], latitude: Double) -> [(String, [DegradationDay])] {
        [("all", days)] + SolarSeason.allCases.map { season in
            ("\(season)", days.filter { DegradationBacktest.season(of: $0.day, latitude: latitude) == season })
        }
    }

    var row: String {
        String(format: "%d | %.2f | %+.2f | %.2f", count, mae, bias, meanActual)
    }
}

enum DegradationBacktest {
    /// Fewer held-out days than this make a season inconclusive.
    static let minSeasonDays = 10
    /// Material seasonal bias: growth in |bias| beyond this share of the season's mean actual kWh.
    static let materialBiasShare = 0.03
    /// A candidate must cut held-out MAE by at least this share.
    static let minMaeGain = 0.05

    static func month(of day: String) -> Int { Int(day.dropFirst(5).prefix(2)) ?? 0 }
    static func year(of day: String) -> Int { Int(day.prefix(4)) ?? 0 }

    static func season(of day: String, latitude: Double) -> SolarSeason {
        SolarSeason.of(month: month(of: day), latitude: latitude)
    }

    static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return .nan }
        let mid = sorted.count / 2
        return sorted.count.isMultiple(of: 2) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    static func interquartileRange(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        guard sorted.count >= 4 else { return .nan }
        let lower = median(Array(sorted.prefix(sorted.count / 2)))
        let upper = median(Array(sorted.suffix(sorted.count / 2)))
        return upper - lower
    }

    /// Matched-month pairs as the shipped estimator forms them: successive observations of one calendar month.
    static func pairs(_ months: [SolarHealthMonthEntry]) -> [DegradationPair] {
        var out: [DegradationPair] = []
        for month in Set(months.map(\.month)).sorted() {
            let sorted = months.filter { $0.month == month }.sorted { $0.year < $1.year }
            for (prev, curr) in zip(sorted, sorted.dropFirst()) {
                let gap = Double(curr.year - prev.year)
                guard prev.factor > 0, gap > 0 else { continue }
                let change: Double = (curr.factor - prev.factor) / prev.factor / gap * 100
                out.append(DegradationPair(month: month, earlier: prev, later: curr, change: change))
            }
        }
        return out
    }

    /// The trend the app reports for `result`, through the shipped classifier.
    static func trend(_ result: SolarHealthResult, manual: ManualSolarLayout?, now: Date)
        -> SolarHealthClassifier.ChangeAnalysis {
        SolarHealthClassifier.analyzeChangeOverTime(from: result, manual: manual, now: now)
    }

    static func describe(_ analysis: SolarHealthClassifier.ChangeAnalysis) -> String {
        let rate = analysis.change.agingPercentPerYear.map { String(format: "%+.2f%%/yr", $0) } ?? "none"
        let confidence = analysis.change.agingConfidence.map { "\($0)" } ?? "no confidence"
        let pairCount = pairs(analysis.change.months).count
        return "\(rate), \(confidence), \(pairCount) matched pairs, finding: \(analysis.finding == nil ? "no" : "YES")"
    }

    /// `result` with each year's months kept or replaced by `transform` (nil drops the month).
    static func reshaped(
        _ result: SolarHealthResult, _ transform: (Int, SolarHealthMonth) -> SolarHealthMonth?
    ) -> SolarHealthResult {
        let years = result.years.map { year in
            SolarHealthYear(
                year: year.year, key: year.key, clearDays: year.clearDays, capacity: year.capacity,
                months: year.months.compactMap { transform(year.year, $0) }, shade: year.shade,
                dailyRatios: year.dailyRatios, hasClipping: year.hasClipping)
        }
        return SolarHealthResult(
            reference: result.reference, years: years, referenceScale: result.referenceScale,
            recomputedYears: result.recomputedYears)
    }

    /// A result built from monthly factors alone, for trends from another expected-energy model.
    static func result(
        reference: SolarHealthReference, monthly: [Int: [Int: (factor: Double, days: Int)]]
    ) -> SolarHealthResult {
        let years = monthly.keys.sorted().map { year in
            let months = (monthly[year] ?? [:]).sorted { $0.key < $1.key }.map {
                SolarHealthMonth(
                    month: $0.key,
                    capacity: SolarHealthCapacity(site: $0.value.factor, directions: [], clearDays: $0.value.days))
            }
            let days = months.reduce(0) { $0 + $1.capacity.clearDays }
            let mean = months.isEmpty ? nil : months.reduce(0) { $0 + $1.capacity.site } / Double(months.count)
            return SolarHealthYear(
                year: year, key: "", clearDays: days,
                capacity: mean.map { SolarHealthCapacity(site: $0, directions: [], clearDays: days) },
                months: months, shade: [], dailyRatios: [])
        }
        return SolarHealthResult(reference: reference, years: years, referenceScale: 1, recomputedYears: [])
    }
}
