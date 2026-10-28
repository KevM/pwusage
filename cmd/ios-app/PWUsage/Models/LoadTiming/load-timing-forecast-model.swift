import Foundation

extension LoadTimingForecastEstimator {
    struct WallClock {
        /// Gregorian, in the site's time zone, for instants outside the scanned range.
        let calendar: Calendar
        let halfHourBoundaries: [Date]
        /// The local minute-of-day each boundary starts.
        let boundaryMinutes: [Int]
        let start: Date
        let end: Date
        /// The local half-hour slot in effect at `start`.
        let startSlotMinute: Int

        init(timeZone: TimeZone, from start: Date, to end: Date) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            self.calendar = calendar
            self.start = start
            self.end = end
            startSlotMinute = Self.slotMinute(at: start, calendar: calendar)
            // Every zone offset and DST shift is a whole quarter hour, so local
            // half-hour boundaries fall on UTC quarter hours. Scan those, reading
            // the zone's offset rather than a calendar, which is much cheaper
            // across a whole billing cycle.
            var boundaries: [Date] = []
            var minutes: [Int] = []
            let step = 15 * 60
            var cursor = (Int(floor(start.timeIntervalSince1970)) / step) * step + step
            if Double(cursor) <= start.timeIntervalSince1970 { cursor += step }
            // The offset only changes at a zone transition, so read it there.
            var offset = timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(cursor)))
            var nextTransition = timeZone.nextDaylightSavingTimeTransition(after: Date(timeIntervalSince1970: Double(cursor)))
            while Double(cursor) < end.timeIntervalSince1970 {
                let date = Date(timeIntervalSince1970: Double(cursor))
                if let transition = nextTransition, date >= transition {
                    offset = timeZone.secondsFromGMT(for: date)
                    nextTransition = timeZone.nextDaylightSavingTimeTransition(after: date)
                }
                let local = cursor + offset
                let secondOfDay = ((local % 86_400) + 86_400) % 86_400
                if secondOfDay.isMultiple(of: 1800) {
                    boundaries.append(date)
                    minutes.append(secondOfDay / 60)
                }
                cursor += step
            }
            halfHourBoundaries = boundaries
            boundaryMinutes = minutes
        }

        /// Local half-hour boundaries strictly between `start` and `end`.
        func halfHours(after start: Date, before end: Date) -> ArraySlice<Date> {
            let lower = halfHourBoundaries.partitionPoint { $0 > start }
            let upper = halfHourBoundaries.partitionPoint { $0 >= end }
            return lower < upper ? halfHourBoundaries[lower ..< upper] : []
        }

        /// The local minute-of-day starting the half-hour slot that contains `date`.
        /// Both occurrences of a repeated fall-back hour map to the same slots.
        func slotMinute(at date: Date) -> Int {
            guard date >= start, date < end else { return Self.slotMinute(at: date, calendar: calendar) }
            let index = halfHourBoundaries.partitionPoint { $0 > date }
            return index == 0 ? startSlotMinute : boundaryMinutes[index - 1]
        }

        static func slotMinute(at date: Date, calendar: Calendar) -> Int {
            let components = calendar.dateComponents([.hour, .minute], from: date)
            return ((components.hour ?? 0) * 60 + (components.minute ?? 0)) / 30 * 30
        }
    }

    /// Household flow at one instant: what the baseline exports to the grid, and the
    /// solar left over after the home and any battery charging, which an added load can use.
    struct Flow {
        let netExportKw: Double
        let physicalSurplusKw: Double
    }

    /// Where the household flow at an instant comes from: the solar forecast
    /// with the household pattern before `forecastEnd`, the site's grid history
    /// after it (and throughout `.history`), or nothing for `.flat`.
    struct FlowModel {
        let projection: Projection
        let clock: WallClock
        /// The forecast drives the flow over [forecastStart, forecastEnd); history elsewhere.
        let forecastStart: Date
        let forecastEnd: Date
        /// Use `pv_estimate10` and the 1-in-4 week instead of the medians.
        let cautious: Bool
        static let daysPerWeekRoot = 7.0.squareRoot()
        /// Forecast intervals that drive the flow (those starting before `forecastEnd`).
        let intervals: [SolarForecastInterval]
        let slots: [Int: PlanningSlot]
        /// Every instant where the flow or the tariff can change, sorted: forecast
        /// interval edges, the switch to history, tariff edges and local half hours.
        let boundaries: [Date]

        init(projection: Projection, clock: WallClock, forecastStart: Date = .distantPast, forecastEnd: Date,
             tariffs: [LoadTimingTariffSegment], cautious: Bool = false) {
            self.projection = projection
            self.clock = clock
            self.forecastStart = forecastStart
            self.forecastEnd = forecastEnd
            self.cautious = cautious
            intervals = projection.intervals.filter { $0.periodStart < forecastEnd }.sorted { $0.periodStart < $1.periodStart }
            // Each source is already in order, so a merge is cheaper than hashing and sorting.
            var edges = Array(clock.halfHours(after: .distantPast, before: .distantFuture))
            edges.append(contentsOf: intervals.flatMap { [$0.periodStart, $0.periodEnd] })
            edges.append(forecastStart)
            edges.append(forecastEnd)
            edges.append(contentsOf: tariffs.flatMap { [$0.start, $0.end] })
            edges.sort()
            var unique: [Date] = []
            unique.reserveCapacity(edges.count)
            for edge in edges where unique.last != edge { unique.append(edge) }
            boundaries = unique
            // A slot is usable only when its minute appears exactly once.
            let grouped = Dictionary(grouping: projection.context?.slots ?? [], by: \.localMinute)
            slots = grouped.compactMapValues { matches in
                guard matches.count == 1, let match = matches.first, match.localMinute >= 0,
                      match.localMinute < 1440, match.localMinute.isMultiple(of: 30) else { return nil }
                return match
            }
        }

        private init(cautiousCopyOf model: FlowModel) {
            projection = model.projection
            clock = model.clock
            forecastStart = model.forecastStart
            forecastEnd = model.forecastEnd
            cautious = true
            intervals = model.intervals
            slots = model.slots
            boundaries = model.boundaries
        }

        func cautiousModel() -> FlowModel { FlowModel(cautiousCopyOf: self) }

        /// `start`, every boundary strictly between, and `end`.
        func boundaries(from start: Date, to end: Date) -> [Date] {
            guard start < end else { return start == end ? [start] : [end, start].sorted() }
            let lower = boundaries.partitionPoint { $0 > start }
            let upper = boundaries.partitionPoint { $0 >= end }
            var values = [start]
            if lower < upper { values.append(contentsOf: boundaries[lower ..< upper]) }
            values.append(end)
            return values
        }

        func slot(at date: Date) -> PlanningSlot? {
            slots[clock.slotMinute(at: date)]
        }

        /// The forecast interval containing `date` (intervals are sorted and non-overlapping).
        func interval(at date: Date) -> SolarForecastInterval? {
            let index = intervals.partitionPoint { $0.periodEnd > date }
            guard index < intervals.count, intervals[index].periodStart <= date else { return nil }
            return intervals[index]
        }

        func usesForecast(at date: Date) -> Bool {
            if case .forecast = projection { return date >= forecastStart && date < forecastEnd }
            return false
        }

        /// The household pattern (forecast window) or the grid history covers `date`.
        func hasContext(at date: Date) -> Bool {
            guard projection.projectsFlow else { return true }
            guard let slot = slot(at: date) else { return false }
            if usesForecast(at: date) {
                guard let home = slot.homeKw, let battery = slot.batteryNetChargeKw else { return false }
                return home.isFinite && battery.isFinite
            }
            return slot.gridNetExportKw?.isFinite ?? false
        }

        /// A forecast interval covers `date`, or `date` is outside the forecast window.
        func hasForecast(at date: Date) -> Bool {
            guard usesForecast(at: date) else { return true }
            return interval(at: date) != nil
        }

        /// `nil` when the forecast, household pattern or history doesn't cover `date`. `.flat` never moves.
        func flow(at date: Date) -> Flow? {
            guard projection.projectsFlow else { return Flow(netExportKw: 0, physicalSurplusKw: 0) }
            guard let slot = slot(at: date) else { return nil }
            if usesForecast(at: date) {
                guard let interval = interval(at: date),
                      let home = slot.homeKw, let battery = slot.batteryNetChargeKw,
                      home.isFinite, battery.isFinite else { return nil }
                var solar = interval.powerKw
                if cautious, let dull = interval.cautiousPowerKw, dull.isFinite {
                    solar += (dull - solar) * LoadTimingForecastEstimator.forecastCautiousWeight
                }
                return Flow(netExportKw: solar - home - battery, physicalSurplusKw: solar - home - max(battery, 0))
            }
            guard let typical = slot.gridNetExportKw, typical.isFinite else { return nil }
            var grid = typical
            if cautious, let dull = slot.cautiousGridNetExportKw, dull.isFinite {
                // The server's dull day is a 1-in-4 *day*. Repeating it every day of
                // the safety window would be a week of dull days in a row, far rarer
                // than 1 in 4. A 1-in-4 week of roughly independent days falls short
                // of the typical week by about √7 dull-day gaps, so each day moves
                // 1/√7 of the way toward the dull day.
                grid = typical + (dull - typical) / Self.daysPerWeekRoot
            }
            // History records only what reached the grid; that export is what an added load could use.
            return Flow(netExportKw: grid, physicalSurplusKw: grid)
        }
    }

    /// The projection cut at every instant where the flow or the tariff can
    /// change, with each step's period and its typical and cautious flow. It is
    /// resolved once per plan, so pricing a run and drawing lanes walk arrays
    /// instead of looking the flow and tariff up at every point.
    struct Steps {
        /// Step `i` runs from `edges[i]` to `edges[i + 1]`.
        let edges: [Date]
        let periods: [String]
        let typical: [Flow]
        let cautious: [Flow]

        /// `nil` when a forecast interval, the household pattern or history, or a
        /// tariff segment is missing somewhere in [start, end].
        init?(from start: Date, to end: Date, model: FlowModel, tariffs: [LoadTimingTariffSegment]) {
            let points = model.boundaries(from: start, to: end)
            guard start < end, points.count >= 2 else { return nil }
            let cautiousModel = model.cautiousModel()
            var periods: [String] = [], typical: [Flow] = [], cautious: [Flow] = []
            periods.reserveCapacity(points.count)
            typical.reserveCapacity(points.count)
            cautious.reserveCapacity(points.count)
            for index in 0 ..< (points.count - 1) {
                let a = points[index], b = points[index + 1]
                guard b > a else { return nil }
                let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
                guard model.hasForecast(at: mid),
                      let tariff = LoadTimingForecastEstimator.segment(at: mid, in: tariffs),
                      let flow = model.flow(at: mid), let dull = cautiousModel.flow(at: mid) else { return nil }
                periods.append(tariff.periodKey)
                typical.append(flow)
                cautious.append(dull)
            }
            edges = points
            self.periods = periods
            self.typical = typical
            self.cautious = cautious
        }

        /// The step containing `date`, or `nil` outside the steps.
        func step(containing date: Date) -> Int? {
            guard let first = edges.first, let last = edges.last, date >= first, date < last else { return nil }
            return edges.partitionPoint { $0 > date } - 1
        }

        /// Integrates the typical (or cautious) flow over [start, end] onto `balances`.
        func integrate(from start: Date, to end: Date, balances: [String: Double], cautious useCautious: Bool) -> BaselineResult {
            var result = balances
            guard start < end, var index = step(containing: start), end <= edges[edges.count - 1] else {
                return .incompleteCoverage
            }
            while index < periods.count, edges[index] < end {
                let a = max(edges[index], start), b = min(edges[index + 1], end)
                guard let old = result[periods[index]] else { return .incompleteCoverage }
                let seconds = b.timeIntervalSince(a)
                let hours = seconds / 3600
                let netPower = useCautious ? cautious[index].netExportKw : typical[index].netExportKw
                let netExport = netPower * hours
                let updated = old + netExport
                guard seconds.isFinite, hours.isFinite, netPower.isFinite, netExport.isFinite, updated.isFinite else {
                    return .invalidInput
                }
                result[periods[index]] = updated
                index += 1
            }
            return .balances(result)
        }
    }
}
