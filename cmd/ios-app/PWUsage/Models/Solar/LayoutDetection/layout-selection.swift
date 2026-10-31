import Foundation

/// Clear-interval selection, AC clip detection and learned shading (port of the detector's
/// `selection.ts`). Series sit on a regular 5-minute UTC grid; missing samples are NaN.

private let stepMs = 300_000.0
private let dayMs = 86_400_000.0
private let azimuthBinCount = 36

struct LayoutSeriesPoint: Equatable, Sendable {
    let time: Date
    /// Production in kW with the night baseline removed; NaN where no sample exists.
    let powerKw: Double
    let sun: LayoutSunSample
    /// Site-local calendar day, `yyyy-MM-dd`.
    let localDay: String
}

struct LayoutSeries: RandomAccessCollection, Sendable {
    let points: [LayoutSeriesPoint]

    var startIndex: Int { points.startIndex }
    var endIndex: Int { points.endIndex }

    subscript(position: Int) -> LayoutSeriesPoint { points[position] }
}

struct ClipDetection: Equatable, Sendable {
    let limitKw: Double
    let intervals: Int
    let days: Int
}

struct ShadeSegment: Equatable, Sendable {
    var azimuthFrom: Double
    var azimuthTo: Double
    var belowElevation: Double
}

/// A strong-deficit bin above the horizon: 10 degrees of azimuth by 5 degrees of elevation.
struct ShadeHotBin: Equatable, Sendable {
    let azimuth: Double
    let elevation: Double
}

/// Learned horizon profile (one value per 10 degrees of azimuth) plus isolated hot bins.
struct ShadeMask: Sendable {
    let horizon: [Double]
    let hotBins: [ShadeHotBin]

    func shaded(azimuth: Double, elevation: Double) -> Bool {
        guard azimuth.isFinite else { return false }
        let bin = Int(min(max(floor(azimuth / 10), 0), Double(horizon.count - 1)))
        if elevation <= horizon[bin] { return true }
        return hotBins.contains { hot in
            azimuth >= hot.azimuth && azimuth < hot.azimuth + 10
                && elevation >= hot.elevation && elevation < hot.elevation + 5
        }
    }

    /// Horizon profile merged into contiguous segments (reference `summary` / `_merge_segments`).
    func summary() -> [ShadeSegment] {
        var out: [ShadeSegment] = []
        for (bin, height) in horizon.enumerated() where height.isFinite {
            if let last = out.last, last.azimuthTo == Double(bin * 10), abs(last.belowElevation - height) <= 5 {
                out[out.count - 1].azimuthTo = Double((bin + 1) * 10)
                out[out.count - 1].belowElevation = max(last.belowElevation, height)
            } else {
                out.append(ShadeSegment(
                    azimuthFrom: Double(bin * 10), azimuthTo: Double((bin + 1) * 10), belowElevation: height))
            }
        }
        return out
    }
}

/// numpy-style linear-interpolated quantile of the finite values; NaN when there are none.
func quantile(_ values: [Double], _ fraction: Double) -> Double {
    let sorted = values.filter(\.isFinite).sorted()
    guard !sorted.isEmpty else { return .nan }
    let position = fraction * Double(sorted.count - 1)
    let lower = Int(floor(position))
    let upper = min(lower + 1, sorted.count - 1)
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - Double(lower))
}

func median(_ values: [Double]) -> Double {
    quantile(values, 0.5)
}

/// Regular 5-minute series with midpoint sun and the night baseline removed (reference `detect` lines 426-432).
func layoutSeries(
    samples: [(timestamp: Date, solarWh: Double)], latitude: Double, longitude: Double, timeZone: TimeZone
) -> LayoutSeries {
    guard !samples.isEmpty else { return LayoutSeries(points: []) }
    var byTime: [Double: Double] = [:]
    for sample in samples {
        // Snap to the nearest 5-minute boundary: day records allow irregular timestamps,
        // and one off-grid sample must not shift the whole grid.
        let slot = jsRound(epochMs(sample.timestamp) / stepMs) * stepMs
        if byTime[slot] == nil { byTime[slot] = sample.solarWh * 12 / 1000 }
    }
    let times = byTime.keys.sorted()
    guard let first = times.first, let last = times.last else { return LayoutSeries(points: []) }

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    var rows: [SeriesRow] = []
    var slotMs = first
    while slotMs <= last {
        let raw = byTime[slotMs] ?? .nan
        let time = Date(timeIntervalSince1970: slotMs / 1000)
        let sun = layoutSun(
            at: Date(timeIntervalSince1970: (slotMs + stepMs / 2) / 1000), latitude: latitude, longitude: longitude)
        let parts = calendar.dateComponents([.year, .month, .day], from: time)
        let localDay = String(format: "%04ld-%02ld-%02ld", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        rows.append(SeriesRow(time: time, powerKw: raw.isFinite ? raw : .nan, sun: sun, localDay: localDay))
        slotMs += stepMs
    }

    let night = rows.filter { $0.sun.elevation < -6 && $0.powerKw.isFinite }.map(\.powerKw)
    let baseline = max(night.isEmpty ? 0 : median(night), 0)
    let points = rows.map { row in
        LayoutSeriesPoint(
            time: row.time, powerKw: row.powerKw.isFinite ? max(row.powerKw - baseline, 0) : .nan,
            sun: row.sun, localDay: row.localDay)
    }
    return LayoutSeries(points: points)
}

private struct SeriesRow {
    let time: Date
    let powerKw: Double
    let sun: LayoutSunSample
    let localDay: String
}

/// AC clip plateau: many daylight intervals at the same maximum, in runs of 3+ on 5+ days.
func detectClip(_ series: LayoutSeries) -> ClipDetection? {
    let total = series.count
    let daylight = series.map { $0.sun.elevation > 10 && $0.powerKw.isFinite }
    var values: [Double] = []
    for index in 0 ..< total where daylight[index] { values.append(series[index].powerKw) }
    guard values.count >= 500 else { return nil }
    let high = quantile(values, 0.9999)
    let candidates = Array(
        Set(values.filter { $0 > 0.85 * high }.map { jsRound($0 * 1000) / 1000 })
            .sorted(by: >)
            .prefix(60))

    var best: ClipDetection?
    for candidate in candidates {
        let (near, count) = clipNearMask(series, daylight: daylight, level: candidate)
        guard count >= 30 else { continue }
        let runDays = clipRunDays(series, near: near)
        let fraction = Double(count) / Double(values.count)
        let above = values.filter { $0 > candidate * 1.015 + 0.013 }.count
        if runDays.count >= 5, fraction > 0.003, Double(above) < 0.05 * Double(count),
           count > (best?.intervals ?? 0) {
            best = ClipDetection(limitKw: candidate, intervals: count, days: runDays.count)
        }
    }
    guard let found = best else { return nil }
    let limit = found.limitKw
    var band: [Double] = []
    for index in 0 ..< total where daylight[index] && abs(series[index].powerKw - limit) <= clipTolerance(limit) {
        band.append(series[index].powerKw)
    }
    return ClipDetection(limitKw: jsRound(median(band) * 1000) / 1000, intervals: found.intervals, days: found.days)
}

/// The match tolerance around a clip level.
private func clipTolerance(_ level: Double) -> Double {
    max(0.004 * level, 0.013)
}

/// Daylight intervals within tolerance of `level`, and how many there are.
private func clipNearMask(_ series: LayoutSeries, daylight: [Bool], level: Double) -> (near: [Bool], count: Int) {
    let tolerance = clipTolerance(level)
    var near = [Bool](repeating: false, count: series.count)
    var count = 0
    for index in 0 ..< series.count where daylight[index] && abs(series[index].powerKw - level) <= tolerance {
        near[index] = true
        count += 1
    }
    return (near, count)
}

/// UTC days that contain a run of 3+ consecutive near-plateau intervals.
private func clipRunDays(_ series: LayoutSeries, near: [Bool]) -> Set<Int> {
    let total = series.count
    var runDays = Set<Int>()
    var start = 0
    while start < total {
        guard near[start] else {
            start += 1
            continue
        }
        var end = start
        while end < total && near[end] { end += 1 }
        if end - start >= 3 {
            for member in start ..< end { runDays.insert(utcDayKey(series[member].time)) }
        }
        start = end
    }
    return runDays
}

/// Rolling max (window 7, centred, min 5 finite) of the scaled second difference.
func smoothness(_ values: [Double], scale: Double) -> [Double] {
    let total = values.count
    var curvature = [Double](repeating: .nan, count: total)
    for index in stride(from: 1, to: total - 1, by: 1) {
        curvature[index] = abs(values[index - 1] - 2 * values[index] + values[index + 1]) / scale
    }
    var out = [Double](repeating: .nan, count: total)
    for index in 0 ..< total {
        var count = 0
        var maximum = -Double.infinity
        for neighbour in max(0, index - 3) ... min(total - 1, index + 3) where curvature[neighbour].isFinite {
            count += 1
            if curvature[neighbour] > maximum { maximum = curvature[neighbour] }
        }
        if count >= 5 { out[index] = maximum }
    }
    return out
}

/// Model-free clear mask: output normalised by clear-sky GHI, within a band of its rolling
/// (±7 day) upper envelope at the same UTC slot, and locally smooth.
func envelopeClear(_ series: LayoutSeries, peakKw: Double) -> [Bool] {
    let total = series.count
    guard total > 0 else { return [] }
    let firstDay = utcDayKey(series[0].time)
    let dayCount = utcDayKey(series[total - 1].time) - firstDay + 1
    let slots = 288
    var grid = [Double](repeating: .nan, count: dayCount * slots)
    var normalised = [Double](repeating: .nan, count: total)
    for index in 0 ..< total {
        let point = series[index]
        guard point.sun.elevation > 2 else { continue }
        let value = point.powerKw / max(point.sun.ghi, 30)
        normalised[index] = value
        let cell = (utcDayKey(point.time) - firstDay) * slots + utcSlot(point.time)
        if grid[cell].isNaN { grid[cell] = value }
    }
    let smooth = smoothedEnvelope(grid, dayCount: dayCount, slots: slots)
    let curvature = smoothness(series.map(\.powerKw), scale: peakKw)
    var out = [Bool](repeating: false, count: total)
    for index in 0 ..< total {
        let point = series[index]
        guard point.sun.elevation > 5, normalised[index].isFinite else { continue }
        let reference = smooth[(utcDayKey(point.time) - firstDay) * slots + utcSlot(point.time)]
        let ratio = normalised[index] / reference
        out[index] = ratio > 0.92 && ratio < 1.06 && curvature[index] < 0.03
            && reference * max(point.sun.ghi, 30) > 0.03 * peakKw
    }
    return out
}

/// Rolling 0.85 quantile over 15 days (centred, min 4 finite) per slot, then a 3-slot mean.
private func smoothedEnvelope(_ grid: [Double], dayCount: Int, slots: Int) -> [Double] {
    var envelope = [Double](repeating: .nan, count: dayCount * slots)
    for slot in 0 ..< slots {
        for day in 0 ..< dayCount {
            var buffer: [Double] = []
            for neighbour in max(0, day - 7) ... min(dayCount - 1, day + 7)
                where grid[neighbour * slots + slot].isFinite {
                buffer.append(grid[neighbour * slots + slot])
            }
            if buffer.count >= 4 { envelope[day * slots + slot] = quantile(buffer, 0.85) }
        }
    }
    var smooth = [Double](repeating: .nan, count: dayCount * slots)
    for day in 0 ..< dayCount {
        for slot in 0 ..< slots {
            var sum = 0.0
            var count = 0
            for neighbour in max(0, slot - 1) ... min(slots - 1, slot + 1)
                where envelope[day * slots + neighbour].isFinite {
                sum += envelope[day * slots + neighbour]
                count += 1
            }
            if count > 0 { smooth[day * slots + slot] = sum / Double(count) }
        }
    }
    return smooth
}

/// Curtailment-like flat runs: measured constant (and below model) while the model moves.
func flatRuns(powerKw: [Double], model: [Double], clipKw: Double?) -> [Bool] {
    let total = powerKw.count
    guard total > 0 else { return [] }
    var maxMeasured = -Double.infinity
    var maxModel = -Double.infinity
    for index in 0 ..< total {
        if powerKw[index] > maxMeasured { maxMeasured = powerKw[index] }
        if model[index] > maxModel { maxModel = model[index] }
    }
    var flat = [Bool](repeating: false, count: total)
    for index in stride(from: 1, to: total, by: 1) {
        let measuredStep = abs(powerKw[index] - powerKw[index - 1])
        let modelStep = abs(model[index] - model[index - 1])
        var isFlat = measuredStep < 0.004 * maxMeasured && modelStep > 0.01 * maxModel
            && powerKw[index] > 0.1 * maxMeasured && powerKw[index] < 0.97 * model[index]
        if let clipKw, clipKw > 0 { isFlat = isFlat && powerKw[index] < 0.98 * clipKw }
        flat[index] = isFlat
    }
    var out = [Bool](repeating: false, count: total)
    for index in 0 ..< total {
        var sum = 0
        for neighbour in max(0, index - 2) ... min(total - 1, index + 2) where flat[neighbour] { sum += 1 }
        out[index] = sum >= 3
    }
    return out
}

/// Horizon profile: for each 10° sun-azimuth bin, the lowest elevation above which the
/// 80th-percentile measured/model ratio is >= `threshold` in every populated 2.5° bin, plus
/// isolated strong-deficit bins above it (chimney, vent, pole).
func learnShade(
    saz: [Double], sel: [Double], ratio: [Double], dayIds: [String], threshold: Double = 0.85
) -> ShadeMask {
    var azimuthBins = [[Int]](repeating: [], count: azimuthBinCount)
    for sample in 0 ..< saz.count {
        guard ratio[sample].isFinite, saz[sample] >= 0, saz[sample] < 360 else { continue }
        azimuthBins[Int(floor(saz[sample] / 10))].append(sample)
    }
    var horizon = [Double](repeating: -.infinity, count: azimuthBinCount)
    for bin in 0 ..< azimuthBinCount {
        let members = azimuthBins[bin]
        guard members.count >= 20 else { continue }
        horizon[bin] = min(
            shadeHeight(members, sel: sel, ratio: ratio, dayIds: dayIds, threshold: threshold), 45)
    }
    var hot: [ShadeHotBin] = []
    for bin in 0 ..< azimuthBinCount {
        let members = azimuthBins[bin]
        for elevationLow in stride(from: 0, to: 90, by: 5) {
            let cell = members.filter {
                sel[$0] >= Double(elevationLow) && sel[$0] < Double(elevationLow + 5) && sel[$0] > horizon[bin]
            }
            if cell.count >= 12, Set(cell.map { dayIds[$0] }).count >= 4,
               quantile(cell.map { ratio[$0] }, 0.8) < 0.75 {
                hot.append(ShadeHotBin(azimuth: Double(bin * 10), elevation: Double(elevationLow)))
            }
        }
    }
    return ShadeMask(horizon: horizon, hotBins: hot)
}

/// The lowest elevation above which a 10° azimuth bin's rows are unshaded: walks the populated
/// 2.5° elevation bins upward while their 80th-percentile ratio stays under `threshold`.
private func shadeHeight(
    _ members: [Int], sel: [Double], ratio: [Double], dayIds: [String], threshold: Double
) -> Double {
    var elevationBins = [[Int]](repeating: [], count: azimuthBinCount)
    for sample in members {
        let elevationBin = floor(sel[sample] / 2.5)
        if elevationBin >= 0, elevationBin < Double(azimuthBinCount) {
            elevationBins[Int(elevationBin)].append(sample)
        }
    }
    var height = -Double.infinity
    for elevationBin in 0 ..< azimuthBinCount {
        let cell = elevationBins[elevationBin]
        if cell.count < 8 || Set(cell.map { dayIds[$0] }).count < 3 { continue }
        if quantile(cell.map { ratio[$0] }, 0.8) < threshold {
            height = Double(elevationBin + 1) * 2.5
        } else {
            break
        }
    }
    return height
}

/// JavaScript `Math.round`: halves round toward positive infinity.
private func jsRound(_ value: Double) -> Double {
    floor(value + 0.5)
}

/// Epoch milliseconds as a whole number.
private func epochMs(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
}

private func utcDayKey(_ time: Date) -> Int {
    Int(floor(epochMs(time) / dayMs))
}

/// Index of the 5-minute slot within the UTC day.
private func utcSlot(_ time: Date) -> Int {
    Int(floor(epochMs(time).truncatingRemainder(dividingBy: dayMs) / stepMs))
}
