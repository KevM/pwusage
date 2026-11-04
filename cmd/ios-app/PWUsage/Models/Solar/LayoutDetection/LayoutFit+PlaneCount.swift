import Foundation

/// Plane-count selection by day-blocked cross-validation, and the day bootstrap.
extension LayoutFit {
    static func rmse(_ model: [Double], _ measured: [Double]) -> Double {
        var sum = 0.0
        for row in 0 ..< measured.count { sum += (model[row] - measured[row]) * (model[row] - measured[row]) }
        return sqrt(sum / Double(max(measured.count, 1)))
    }

    /// Planes from packed params, azimuths wrapped to [0, 360).
    static func toPlanes(_ params: [Double]) -> [LayoutPlane] {
        stride(from: 0, to: params.count, by: 3).map {
            LayoutPlane(azimuth: wrapDegrees(params[$0]), tilt: params[$0 + 1], effectiveKw: params[$0 + 2])
        }
    }

    static func packPlanes(_ planes: [LayoutPlane]) -> [Double] {
        planes.flatMap { [$0.azimuth, $0.tilt, $0.effectiveKw] }
    }

    /// Grid-search group per row: rows below 97% of the clip, when clipped; -1 excludes a row.
    static func fitMaskGroup(_ rows: Rows, clipKw clipInput: Double?, groupOf: (Int) -> Int) -> [Int] {
        let clipKw = clip(clipInput)
        return rows.powerKw.indices.map { row in
            if let clipKw, !(rows.powerKw[row] < 0.97 * clipKw) { return -1 }
            return groupOf(row)
        }
    }

    static func angleDiff(_ lhs: Double, _ rhs: Double) -> Double {
        abs(wrapDegrees(lhs - rhs + 180) - 180)
    }

    /// Planes too similar to be told apart: within 25° azimuth and 10° tilt (reference `distinct`).
    static func distinct(_ planes: [LayoutPlane]) -> Bool {
        for first in planes.indices {
            for second in planes.indices where second > first {
                if angleDiff(planes[first].azimuth, planes[second].azimuth) < 25,
                   abs(planes[first].tilt - planes[second].tilt) < 10 {
                    return false
                }
            }
        }
        return true
    }

    /// Reference `choose_n`: add a plane only for a > 8% held-out gain and a plausible, distinct,
    /// sizeable plane.
    static func choosePlaneCountFrom(_ fits: [Int: [LayoutPlane]], cvNrmse scores: [Int: Double]) -> Int {
        var chosen = 1
        for candidate in [2, 3] {
            let gain = (scores[chosen, default: .nan] - scores[candidate, default: .nan])
                / scores[chosen, default: .nan]
            let planes = fits[candidate, default: []]
            let total = planes.reduce(0) { $0 + $1.effectiveKw }
            let artefact = planes.contains { $0.tilt >= LayoutPOA.maxTilt - 2 && $0.effectiveKw < 0.25 * total }
            let minK = planes.map(\.effectiveKw).min() ?? .infinity
            if gain > 0.08, minK > 0.08 * total, distinct(planes), !artefact {
                chosen = candidate
            } else {
                break
            }
        }
        return chosen
    }

    /// Folds by day: a seeded permutation of the days, mod 5 (reference `dayFolds`).
    static func dayFolds(dayCount: Int, rng: () -> Double) -> [Int] {
        var perm = Array(0 ..< dayCount)
        for position in stride(from: dayCount - 1, to: 0, by: -1) {
            let swapWith = Int(floor(rng() * Double(position + 1)))
            perm.swapAt(position, swapWith)
        }
        return perm.map { $0 % 5 }
    }

    /// Fits for 1-3 planes on all rows plus 5-fold day-blocked CV, from one pass of fold Grams.
    static func planeCountFromRows(
        _ rows: Rows, columns cols: [[Float]], clipKw: Double?, rng: () -> Double,
        checkCancellation: () throws -> Void = {}
    ) throws -> PlaneCount {
        let folds = dayFolds(dayCount: rows.days.count, rng: rng)
        let grams = groupGrams(
            cols, powerKw: rows.powerKw,
            group: fitMaskGroup(rows, clipKw: clipKw) { folds[rows.day[$0]] }, groups: 5)
        try checkCancellation()
        let all = sumGrams(grams)
        var fits: [Int: Fitted] = [:]
        for planes in 1 ... 3 {
            fits[planes] = fitFromGram(rows, gram: all, clipKw: clipKw, planes: planes, starts: planes > 1 ? 4 : 3)
            try checkCancellation()
        }
        let cvNrmse = try crossValidatedNrmse(
            rows, grams: grams, folds: folds, clipKw: clipKw, checkCancellation: checkCancellation)
        let planes = fits.mapValues { toPlanes($0.params) }
        return PlaneCount(
            count: choosePlaneCountFrom(planes, cvNrmse: cvNrmse), cvNrmse: cvNrmse, fits: fits)
    }

    /// Held-out normalised RMSE per plane count: each fold's training fit predicts its test rows.
    private static func crossValidatedNrmse(
        _ rows: Rows, grams: [Gram], folds: [Int], clipKw: Double?, checkCancellation: () throws -> Void
    ) throws -> [Int: Double] {
        // Accumulated held-out [sse, count, sum of y] per plane count.
        var sse = [Double](repeating: 0, count: 3)
        var count = [Double](repeating: 0, count: 3)
        var sum = [Double](repeating: 0, count: 3)
        for fold in 0 ..< 5 {
            let isTest = { (row: Int) -> Bool in folds[rows.day[row]] == fold }
            let testCount = rows.powerKw.indices.filter(isTest).count
            if testCount < 50 { continue }
            let train = subsetRows(rows) { !isTest($0) }
            let test = subsetRows(rows, keep: isTest)
            let trainGram = sumGrams(grams, skip: fold)
            for planes in 1 ... 3 {
                let fit = fitFromGram(train, gram: trainGram, clipKw: clipKw, planes: planes, starts: 2)
                let pred = modelRows(fit.params, rows: test, clipKw: clipKw)
                var foldSSE = 0.0
                var foldSum = 0.0
                for row in test.powerKw.indices {
                    foldSSE += (pred[row] - test.powerKw[row]) * (pred[row] - test.powerKw[row])
                    foldSum += test.powerKw[row]
                }
                sse[planes - 1] += foldSSE
                count[planes - 1] += Double(test.powerKw.count)
                sum[planes - 1] += foldSum
            }
            try checkCancellation()
        }
        var cvNrmse: [Int: Double] = [:]
        for planes in 1 ... 3 {
            cvNrmse[planes] = sqrt(sse[planes - 1] / count[planes - 1]) / (sum[planes - 1] / count[planes - 1])
        }
        return cvNrmse
    }

    /// Reorders bootstrap planes to match `best` by azimuth and tilt distance (reference `align`).
    static func align(_ boot: [LayoutPlane], best: [LayoutPlane]) -> [LayoutPlane] {
        if best.count == 1 { return boot }
        let perms = best.count == 2
            ? [[0, 1], [1, 0]]
            : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
        func distance(_ bootIndex: Int, _ bestIndex: Int) -> Double {
            angleDiff(boot[bootIndex].azimuth, best[bestIndex].azimuth)
                + 2 * abs(boot[bootIndex].tilt - best[bestIndex].tilt)
        }
        var bestPerm = perms[0]
        var bestCost = Double.infinity
        for perm in perms {
            let cost = perm.enumerated().reduce(0.0) { $0 + distance($1.element, $1.offset) }
            if cost < bestCost {
                bestCost = cost
                bestPerm = perm
            }
        }
        return bestPerm.map { boot[$0] }
    }

    /// Day bootstrap: resamples days with replacement (as row weights) and refines from `best`.
    static func bootstrapRows(
        _ rows: Rows, clipKw: Double?, best: [LayoutPlane], rounds: Int, rng: () -> Double,
        checkCancellation: () throws -> Void = {}
    ) throws -> [[LayoutPlane]] {
        let dayCount = rows.days.count
        var out: [[LayoutPlane]] = []
        for _ in 0 ..< rounds {
            var counts = [Double](repeating: 0, count: dayCount)
            for _ in 0 ..< dayCount { counts[Int(floor(rng() * Double(dayCount)))] += 1 }
            let weighted = Rows(
                sun: rows.sun, powerKw: rows.powerKw, day: rows.day, days: rows.days,
                weight: rows.day.map { counts[$0] })
            let sub = subsetRows(weighted) { weighted.weight[$0] > 0 }
            let refined = toPlanes(refine(packPlanes(best), rows: sub, clipKw: clipKw, maxNfev: 80))
            out.append(align(refined, best: best))
            try checkCancellation()
        }
        return out
    }

    /// 5th and 95th percentile azimuth after unwrapping around `reference`, modulo 360
    /// (reference `azimuthRange90`).
    static func azimuthRange90(_ samples: [Double], reference: Double) -> (low: Double, high: Double) {
        let unwrapped = samples.map { reference + wrapDegrees($0 - reference + 180) - 180 }
        let low = quantile(unwrapped, 0.05)
        let high = quantile(unwrapped, 0.95)
        return (wrapDegrees(low), wrapDegrees(high))
    }
}
