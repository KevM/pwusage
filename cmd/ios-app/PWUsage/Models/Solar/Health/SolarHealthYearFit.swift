import Foundation

/// One calendar year of the health pass: clear rows against the reference model, then capacity
/// per year and month, shade per season and the daily ratios. It reuses the detector's clear-day
/// selection (envelope, clip, outlier and shade keep mask) and adds nothing of its own to it.
struct SolarHealthYearFit {
    struct Place {
        let reference: SolarHealthReference
        let latitude: Double
        let longitude: Double
        let timeZone: TimeZone
    }

    static let minYearClearDays = 10
    static let minMonthClearDays = 4
    static let minSeasonClearDays = 5
    /// Rows a day needs to give a ratio (two hours of 5-minute rows).
    static let minRatioRows = 24
    /// Measured power at or above this share of the AC clip is the inverter's limit, not the panels'.
    static let clipMargin = 0.97

    let place: Place
    let selection: SolarLayoutDetector.ClearDaySelection
    let rows: LayoutFit.Rows
    /// Reference model kW per direction for every clear row (zero where no system was installed yet).
    let models: [[Double]]
    let covered: [Bool]
    let total: [Double]
    let fitRows: [Int]
    let monthOfDay: [Int]

    /// Nil when the year has too little to select clear days from.
    init?(samples: [(timestamp: Date, solarWh: Double)], place: Place, checkCancellation: () throws -> Void) throws {
        let series = layoutSeries(
            samples: samples, latitude: place.latitude, longitude: place.longitude, timeZone: place.timeZone)
        try checkCancellation()
        guard !series.points.isEmpty,
              case .selected(let selection) = try SolarLayoutDetector.selectClearDays(
                  series, checkCancellation: checkCancellation) else { return nil }
        let rows = selection.fit.rows
        let reference = Self.referenceModels(rows: rows, place: place)
        let total = rows.powerKw.indices.map { row in reference.models.reduce(0) { $0 + $1[row] } }
        let finalKeep = selection.finalKeep
        let clip = LayoutFit.clip(selection.clipKw)
        self.place = place
        self.selection = selection
        self.rows = rows
        models = reference.models
        covered = reference.covered
        self.total = total
        fitRows = rows.powerKw.indices.filter { row in
            finalKeep[row] && reference.covered[row] && (clip.map { rows.powerKw[row] < Self.clipMargin * $0 } ?? true)
        }
        monthOfDay = rows.days.map { Int($0.dropFirst(5).prefix(2)) ?? 0 }
        try checkCancellation()
    }

    func result(year: Int, checkCancellation: () throws -> Void) throws -> SolarHealthYear {
        let capacity = capacity(of: fitRows, minimumDays: Self.minYearClearDays)
        var months: [SolarHealthMonth] = []
        for month in 1 ... 12 {
            let monthRows = fitRows.filter { monthOfDay[rows.day[$0]] == month }
            if let monthCapacity = self.capacity(of: monthRows, minimumDays: Self.minMonthClearDays) {
                months.append(SolarHealthMonth(month: month, capacity: monthCapacity))
            }
        }
        try checkCancellation()
        let shade = try capacity.map { try seasonShade(factor: $0.site, checkCancellation: checkCancellation) } ?? []
        return SolarHealthYear(
            year: year, key: "", clearDays: selection.days.clear.count, capacity: capacity, months: months,
            shade: shade, dailyRatios: dailyRatios(), hasClipping: LayoutFit.clip(selection.clipKw) != nil)
    }

    private func clearDayCount(of indices: [Int]) -> Int {
        Set(indices.map { rows.day[$0] }).count { selection.days.clear.contains(rows.days[$0]) }
    }

    private func capacity(of indices: [Int], minimumDays: Int) -> SolarHealthCapacity? {
        let days = clearDayCount(of: indices)
        guard days >= minimumDays,
              let scales = SolarHealthFit.scales(measured: rows.powerKw, models: models, rows: indices) else {
            return nil
        }
        let reference = place.reference
        let directions = scales.perDirection.map { factors in
            zip(reference.directions, factors).map { SolarHealthCapacity.Direction(azimuth: $0.azimuth, factor: $1) }
        } ?? [SolarHealthCapacity.Direction(azimuth: reference.dominantDirection.azimuth, factor: scales.site)]
        return SolarHealthCapacity(site: scales.site, directions: directions, clearDays: days)
    }

    /// Lightweight inputs needed to recompute clipped daily energy after cross-year normalization.
    struct ScaledEnergyInputs: Sendable {
        let clipKw: Double
        let dayPowers: [String: [Double]]

        func expectedDailyKwh(referenceScale: Double) -> [String: Double] {
            dayPowers.mapValues { powers in
                let sum = powers.reduce(0) { total, power in
                    total + SolarHealthYearFit.clipPower(referenceScale * power, clip: clipKw)
                }
                return (sum / 12 * 100).rounded() / 100
            }
        }
    }

    static func clipPower(_ power: Double, clip: Double?) -> Double {
        guard let clip else { return power }
        return clip * LayoutPOA.softmin(power / clip)
    }

    /// The reference total with the inverter's clip applied, as the detector models it.
    private func clipped(_ power: Double) -> Double {
        Self.clipPower(power, clip: LayoutFit.clip(selection.clipKw))
    }

    /// Per season: the horizon learned from every clear row of the season, as measured over the
    /// reference scaled by the year's capacity.
    private func seasonShade(factor: Double, checkCancellation: () throws -> Void) throws -> [SolarSeasonShade] {
        let fit = selection.fit
        let ratio = rows.powerKw.indices.map { row -> Double in
            let model = covered[row] ? clipped(factor * total[row]) : 0
            return model > 0.02 * fit.peak ? rows.powerKw[row] / model : .nan
        }
        var out: [SolarSeasonShade] = []
        for season in SolarSeason.allCases {
            try checkCancellation()
            let indices = rows.powerKw.indices.filter {
                SolarSeason.of(month: monthOfDay[rows.day[$0]], latitude: place.latitude) == season
            }
            let days = clearDayCount(of: indices)
            guard days >= Self.minSeasonClearDays else { continue }
            let mask = learnShade(
                saz: indices.map { fit.azimuths[$0] }, sel: indices.map { fit.elevations[$0] },
                ratio: indices.map { ratio[$0] }, dayIds: indices.map { fit.dayIds[$0] })
            out.append(SolarSeasonShade(season: season, map: SolarShadeMap(mask), clearDays: days))
        }
        return out
    }

    /// Returns lightweight energy inputs for clipped years; nil when no inverter clipping was detected.
    var scaledEnergyInputs: ScaledEnergyInputs? {
        guard let clip = LayoutFit.clip(selection.clipKw) else { return nil }
        var dayPowers: [String: [Double]] = [:]
        for row in rows.powerKw.indices where covered[row] && rows.powerKw[row].isFinite {
            let day = rows.days[rows.day[row]]
            if selection.days.clear.contains(day) {
                dayPowers[day, default: []].append(total[row])
            }
        }
        return ScaledEnergyInputs(clipKw: clip, dayPowers: dayPowers)
    }

    /// Expected clear-day energy (kWh) keyed by day string, scaling reference power before clipping.
    func expectedDailyKwh(referenceScale: Double) -> [String: Double] {
        if let inputs = scaledEnergyInputs {
            return inputs.expectedDailyKwh(referenceScale: referenceScale)
        }
        let totals = dayEnergyTotals(referenceScale: referenceScale).expected
        var out: [String: Double] = [:]
        for day in rows.days.indices where selection.days.clear.contains(rows.days[day]) {
            if let sum = totals[day] {
                out[rows.days[day]] = (sum / 12 * 100).rounded() / 100
            }
        }
        return out
    }

    private func dayEnergyTotals(referenceScale: Double) -> (measured: [Int: Double], expected: [Int: Double]) {
        var measured: [Int: Double] = [:]
        var expected: [Int: Double] = [:]
        for row in rows.powerKw.indices where covered[row] && rows.powerKw[row].isFinite {
            measured[rows.day[row], default: 0] += rows.powerKw[row]
            expected[rows.day[row], default: 0] += clipped(referenceScale * total[row])
        }
        return (measured, expected)
    }

    /// Measured over reference energy on each clear day: `ratio` uses the unclipped, unrejected clear
    /// rows for trend rules, while `expectedKwh` / `actualKwh` sum all covered finite rows of the day.
    private func dailyRatios() -> [SolarDailyRatio] {
        var measured: [Int: Double] = [:]
        var expected: [Int: Double] = [:]
        var count: [Int: Int] = [:]
        for row in fitRows {
            measured[rows.day[row], default: 0] += rows.powerKw[row]
            expected[rows.day[row], default: 0] += clipped(total[row])
            count[rows.day[row], default: 0] += 1
        }
        let full = dayEnergyTotals(referenceScale: 1)
        return rows.days.indices.compactMap { day in
            guard selection.days.clear.contains(rows.days[day]), count[day, default: 0] >= Self.minRatioRows,
                  let reference = expected[day], reference > 0 else { return nil }
            let actual = measured[day] ?? 0
            let dayExpected = full.expected[day] ?? reference
            let dayActual = full.measured[day] ?? actual
            return SolarDailyRatio(
                day: rows.days[day],
                ratio: (actual / reference * 10_000).rounded() / 10_000,
                expectedKwh: (dayExpected / 12 * 100).rounded() / 100,
                actualKwh: (dayActual / 12 * 100).rounded() / 100)
        }.sorted { $0.day < $1.day }
    }
}
