import Foundation

/// Clear-day selection shared by layout detection, the clear-day pass and the health pass.
extension SolarLayoutDetector {
    /// The stages through clear-day selection, shared by `detect` and `classifyDays`.
    struct ClearDaySelection {
        let clipKw: Double?
        let fit: ClearFit
        let keep: [Bool]
        let shadeMask: ShadeMask
        let days: (clear: Set<String>, use: Set<String>)

        /// The rows the layout fit uses: kept by the outlier and shade mask, on a day with enough clear rows.
        var finalKeep: [Bool] {
            fit.rows.powerKw.indices.map { keep[$0] && days.use.contains(fit.dayIds[$0]) }
        }
    }

    enum ClearDayStage {
        /// An early exit, with the AC clip when it was detected first.
        case stopped(DetectedSolarLayout.Shortfall, clipKw: Double?)
        case selected(ClearDaySelection)
    }

    /// Clear-day selection without the producing-day gate: peak, AC clip, clear rows and the
    /// shade mask learned from a two-plane fit.
    static func selectClearDays(
        _ series: LayoutSeries, checkCancellation: () throws -> Void
    ) throws -> ClearDayStage {
        let peak = quantile(series.points.filter { $0.sun.elevation > 10 }.map(\.powerKw), 0.999)
        guard peak > 0 else { return .stopped(.noDaylightProduction, clipKw: nil) }
        let clipKw = detectClip(series)?.limitKw
        try checkCancellation()

        let clearIndices = selectClearIndices(series, peak: peak, clipKw: clipKw)
        let rows = LayoutFit.fitRows(series, selected: mask(of: clearIndices, count: series.points.count))
        guard rows.powerKw.count >= 200 else { return .stopped(.fewClearSamples, clipKw: clipKw) }
        let columns = LayoutFit.gridColumns(rows)
        try checkCancellation()

        let fit = ClearFit(
            series: series, clearIndices: clearIndices, rows: rows, columns: columns, clipKw: clipKw, peak: peak)
        let (keep, shadeMask) = try fit.learnKeepMask(checkCancellation: checkCancellation)
        let days = clearDaySets(series, clearIndices: clearIndices, keep: keep, shadeMask: shadeMask)
        return .selected(ClearDaySelection(clipKw: clipKw, fit: fit, keep: keep, shadeMask: shadeMask, days: days))
    }

    /// The clear-selected rows with their sun geometry, and the two-plane fit that learns the shade mask.
    struct ClearFit {
        let rows: LayoutFit.Rows
        let columns: [[Float]]
        let clipKw: Double?
        let peak: Double
        /// Sun azimuth (`saz`), elevation (`sel`) and local day per clear row.
        let azimuths: [Double]
        let elevations: [Double]
        let dayIds: [String]

        init(
            series: LayoutSeries, clearIndices: [Int], rows: LayoutFit.Rows, columns: [[Float]],
            clipKw: Double?, peak: Double
        ) {
            self.rows = rows
            self.columns = columns
            self.clipKw = clipKw
            self.peak = peak
            azimuths = clearIndices.map { series[$0].sun.azimuth }
            elevations = clearIndices.map { series[$0].sun.elevation }
            dayIds = clearIndices.map { series[$0].localDay }
        }

        func fitTwo(_ keep: [Bool]) -> [Double] {
            let gram = LayoutFit.groupGrams(
                columns, powerKw: rows.powerKw,
                group: LayoutFit.fitMaskGroup(rows, clipKw: clipKw) { keep[$0] ? 0 : -1 }, groups: 1)[0]
            let sub = LayoutFit.subsetRows(rows) { keep[$0] }
            return LayoutFit.fitFromGram(sub, gram: gram, clipKw: clipKw, planes: 2, starts: 3).params
        }

        /// The model only learns a persistent-deficit shade mask and drops gross outliers
        /// (snow, curtailment); a tight model-ratio band would hide real extra planes.
        func learnKeepMask(checkCancellation: () throws -> Void) throws -> (keep: [Bool], shadeMask: ShadeMask) {
            let rowCount = rows.powerKw.count
            var keep = [Bool](repeating: true, count: rowCount)
            var pars = fitTwo(keep)
            try checkCancellation()
            var shadeMask = ShadeMask(horizon: [], hotBins: [])
            for _ in 0 ..< 2 {
                let model = LayoutFit.modelRows(pars, rows: rows, clipKw: clipKw)
                let ratio = model.indices.map { model[$0] > 0.02 * peak ? rows.powerKw[$0] / model[$0] : Double.nan }
                shadeMask = learnShade(saz: azimuths, sel: elevations, ratio: ratio, dayIds: dayIds)
                let flat = flatRuns(powerKw: rows.powerKw, model: model, clipKw: clipKw)
                let mask = shadeMask
                keep = (0 ..< rowCount).map { row in
                    abs(rows.powerKw[row] - model[row]) < 0.15 * peak && !flat[row]
                        && !mask.shaded(azimuth: azimuths[row], elevation: elevations[row])
                }
                pars = fitTwo(keep)
                try checkCancellation()
            }
            return (keep, shadeMask)
        }
    }
}
