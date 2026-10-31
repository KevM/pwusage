import Foundation

/// Plane fitting (port of the detector's `fit.ts`). The exhaustive azimuth x tilt grid is solved
/// linearly through Gram matrices; the best candidates are refined continuously with a robust
/// (soft-L1) Levenberg-Marquardt fit, clipping included as a smooth cap. Gram matrices are
/// accumulated per cross-validation fold so the CV reuses one pass over the rows.
enum LayoutFit {
    private static let fScale = 0.08
    private static let hAzimuth = 0.5
    private static let hTilt = 0.25

    /// Grid (azimuth, tilt) combinations: 36 azimuths at each tilt above 0°, and one flat plane.
    static let combos: [(azimuth: Double, tilt: Double)] = stride(from: 0, through: 50, by: 5).flatMap { tilt -> [(azimuth: Double, tilt: Double)] in
        let tiltValue = Double(tilt)
        return tilt > 0
            ? (0 ..< 36).map { (azimuth: Double($0) * 10, tilt: tiltValue) }
            : [(azimuth: 180, tilt: tiltValue)]
    }

    /// Rows used for fitting: geometry, measured kW, day index and a weight (bootstrap counts).
    struct Rows: Sendable {
        var sun: LayoutSunArrays
        var y: [Double]
        var day: [Int]
        var days: [String]
        var weight: [Double]
    }

    /// Gram matrix of one group: `G` is the m x m row-major normal matrix, `b` the right-hand side.
    struct Gram: Sendable {
        var G: [Double]
        var b: [Double]
        var yy: Double
    }

    /// A grid candidate: the sum of squared errors, the combo indices and the plane sizes.
    struct Candidate: Sendable {
        let sse: Double
        let idx: [Int]
        let k: [Double]
    }

    struct Fitted: Sendable {
        let params: [Double]
        let rmseKw: Double
        let candidates: [Candidate]
    }

    struct PlaneCount: Sendable {
        let count: Int
        let cvNrmse: [Int: Double]
        let fits: [Int: Fitted]
    }

    /// Mulberry32, bit-for-bit the reference `seededRng`: uniform draws in [0, 1).
    static func seededRng(_ seed: UInt32) -> () -> Double {
        var state = seed
        return {
            state = state &+ 0x6d2b79f5
            var t = state
            t = (t ^ (t >> 15)) &* (t | 1)
            t = t ^ (t &+ ((t ^ (t >> 7)) &* (t | 61)))
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// Rows of `series` that are selected and have a finite measurement.
    static func fitRows(_ series: LayoutSeries, selected: [Bool]) -> Rows {
        let indices = series.indices.filter { selected[$0] && series[$0].kw.isFinite }
        var days: [String] = []
        var dayIndex: [String: Int] = [:]
        var day: [Int] = []
        for index in indices {
            let name = series[index].localDay
            if let known = dayIndex[name] {
                day.append(known)
            } else {
                dayIndex[name] = days.count
                day.append(days.count)
                days.append(name)
            }
        }
        return Rows(
            sun: LayoutSunArrays(suns: indices.map { series[$0].sun }),
            y: indices.map { series[$0].kw }, day: day, days: days,
            weight: [Double](repeating: 1, count: indices.count))
    }

    /// The rows for which `keep` holds, in order.
    static func subsetRows(_ rows: Rows, keep: (Int) -> Bool) -> Rows {
        let indices = rows.y.indices.filter(keep)
        return Rows(
            sun: rows.sun.subset(indices), y: indices.map { rows.y[$0] }, day: indices.map { rows.day[$0] },
            days: rows.days, weight: indices.map { rows.weight[$0] })
    }

    /// Grid columns (kW per kW for every combo) for a set of rows, stored as Float like the reference.
    static func gridColumns(_ rows: Rows) -> [[Float]] {
        combos.map { combo in
            LayoutPOA.poaColumn(rows.sun, azimuth: combo.azimuth, tilt: combo.tilt).map { Float($0) }
        }
    }

    /// Gram matrices per group (`group[r]` in 0..<groups, -1 excluded): the upper triangle of the
    /// sum of outer products of each row's grid values, mirrored. Rows are processed in
    /// cache-sized blocks laid out row-major.
    static func groupGrams(_ cols: [[Float]], y: [Double], group: [Int], groups: Int) -> [Gram] {
        let m = cols.count
        var out = (0 ..< groups).map { _ in Gram(G: [Double](repeating: 0, count: m * m), b: [Double](repeating: 0, count: m), yy: 0) }
        let blockSize = 256
        var block = [Double](repeating: 0, count: blockSize * m)
        for g in 0 ..< groups {
            var pending: [Int] = []
            for r in y.indices where group[r] == g {
                let off = pending.count * m
                for i in 0 ..< m { block[off + i] = Double(cols[i][r]) }
                pending.append(r)
                if pending.count == blockSize {
                    accumulate(&out[g], block: block, rows: pending, y: y, m: m)
                    pending.removeAll(keepingCapacity: true)
                }
            }
            accumulate(&out[g], block: block, rows: pending, y: y, m: m)
            for i in 0 ..< m {
                for j in (i + 1) ..< m { out[g].G[j * m + i] = out[g].G[i * m + j] }
            }
        }
        return out
    }

    /// Adds the block's rows (row-major, `m` per row) into `gram`, row by row.
    private static func accumulate(_ gram: inout Gram, block: [Double], rows: [Int], y: [Double], m: Int) {
        block.withUnsafeBufferPointer { blk in
            gram.G.withUnsafeMutableBufferPointer { G in
                gram.b.withUnsafeMutableBufferPointer { b in
                    for k in rows.indices {
                        let off = k * m
                        let yr = y[rows[k]]
                        gram.yy += yr * yr
                        for i in 0 ..< m {
                            let ai = blk[off + i]
                            if ai == 0 { continue }
                            b[i] += ai * yr
                            let gi = i * m
                            for j in i ..< m { G[gi + j] += ai * blk[off + j] }
                        }
                    }
                }
            }
        }
    }

    /// Sum of the groups' Grams, leaving out group `skip` when given.
    static func sumGrams(_ grams: [Gram], skip: Int = -1) -> Gram {
        let m = grams[0].b.count
        var out = Gram(G: [Double](repeating: 0, count: m * m), b: [Double](repeating: 0, count: m), yy: 0)
        for (k, gram) in grams.enumerated() where k != skip {
            for i in out.G.indices { out.G[i] += gram.G[i] }
            for i in out.b.indices { out.b[i] += gram.b[i] }
            out.yy += gram.yy
        }
        return out
    }

    /// Solves a 3x3 system (row-major `a`) by Cramer's rule, nil when singular.
    private static func solve3(_ a: [Double], _ rhs: [Double]) -> [Double]? {
        let (a00, a01, a02, a10, a11, a12, a20, a21, a22) = (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8])
        let det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
        guard det.isFinite, det != 0 else { return nil }
        let (b0, b1, b2) = (rhs[0], rhs[1], rhs[2])
        return [
            (b0 * (a11 * a22 - a12 * a21) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a21 - a11 * b2)) / det,
            (a00 * (b1 * a22 - a12 * b2) - b0 * (a10 * a22 - a12 * a20) + a02 * (a10 * b2 - b1 * a20)) / det,
            (a00 * (a11 * b2 - b1 * a21) - a01 * (a10 * b2 - b1 * a20) + b0 * (a10 * a21 - a11 * a20)) / det,
        ]
    }

    /// Stable ascending sort by SSE, as the reference's `Array.prototype.sort`.
    private static func sortedBySSE(_ items: [Candidate]) -> [Candidate] {
        items.enumerated()
            .sorted { lhs, rhs in
                lhs.element.sse != rhs.element.sse ? lhs.element.sse < rhs.element.sse : lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// Best grid candidates for 1-3 planes with non-negative sizes (reference `grid_search`).
    static func gridSearch(_ gram: Gram, planes: Int, top: Int = 20) -> [Candidate] {
        let G = gram.G
        let b = gram.b
        let yy = gram.yy
        let m = b.count
        func diagonal(_ i: Int) -> Double { G[i * m + i] }
        if planes == 1 {
            var candidates: [Candidate] = []
            for i in 0 ..< m {
                let k = max(diagonal(i) > 0 ? b[i] / diagonal(i) : 0, 0)
                candidates.append(Candidate(sse: yy - 2 * k * b[i] + k * k * diagonal(i), idx: [i], k: [k]))
            }
            return Array(sortedBySSE(candidates).prefix(top))
        }
        var pairs: [Candidate] = []
        for i in 0 ..< m {
            for j in (i + 1) ..< m {
                let gii = diagonal(i)
                let gjj = diagonal(j)
                let gij = G[i * m + j]
                let det = gii * gjj - gij * gij
                let ki = (gjj * b[i] - gij * b[j]) / det
                let kj = (gii * b[j] - gij * b[i]) / det
                let sse = yy - 2 * (ki * b[i] + kj * b[j]) + ki * ki * gii + 2 * ki * kj * gij + kj * kj * gjj
                if ki < 0 || kj < 0 || !sse.isFinite || det < 1e-9 * gii * gjj { continue }
                pairs.append(Candidate(sse: sse, idx: [i, j], k: [ki, kj]))
            }
        }
        pairs = sortedBySSE(pairs)
        if planes == 2 { return Array(pairs.prefix(top)) }

        // Three planes: extend the best 60 pairs with every third column.
        var extended: [Candidate] = []
        for pair in pairs.prefix(60) {
            let (i, j) = (pair.idx[0], pair.idx[1])
            var best: Candidate?
            for l in 0 ..< m where l != i && l != j {
                let ids = [i, j, l]
                let a = ids.flatMap { r in ids.map { c in G[r * m + c] + (r == c ? 1e-12 : 0) } }
                let rhs = ids.map { b[$0] }
                guard let k = solve3(a, rhs), !k.contains(where: { $0 < 0 }) else { continue }
                var quad = 0.0
                for r in 0 ..< 3 {
                    for c in 0 ..< 3 { quad += k[r] * a[r * 3 + c] * k[c] }
                }
                let sse = yy - 2 * (k[0] * rhs[0] + k[1] * rhs[1] + k[2] * rhs[2]) + quad
                if sse.isFinite, best == nil || sse < best!.sse {
                    best = Candidate(sse: sse, idx: ids, k: k)
                }
            }
            if let best {
                let order = [0, 1, 2].sorted { best.idx[$0] < best.idx[$1] }
                extended.append(Candidate(sse: best.sse, idx: order.map { best.idx[$0] }, k: order.map { best.k[$0] }))
            }
        }
        var seen = Set<String>()
        var unique: [Candidate] = []
        for candidate in sortedBySSE(extended) {
            let key = candidate.idx.map(String.init).joined(separator: ",")
            if seen.insert(key).inserted { unique.append(candidate) }
        }
        return Array(unique.prefix(top))
    }

    /// Model kW for packed params [azimuth, tilt, kW, ...] over the rows.
    static func modelRows(_ params: [Double], rows: Rows, clipKw clipInput: Double?) -> [Double] {
        let n = rows.y.count
        var total = [Double](repeating: 0, count: n)
        for p in stride(from: 0, to: params.count, by: 3) {
            let column = LayoutPOA.poaColumn(rows.sun, azimuth: wrapDegrees(params[p]), tilt: params[p + 1], smooth: true)
            let size = params[p + 2]
            for r in 0 ..< n { total[r] += size * column[r] }
        }
        if let clipKw = clip(clipInput) {
            for r in 0 ..< n { total[r] = clipKw * LayoutPOA.softmin(total[r] / clipKw) }
        }
        return total
    }

    /// Solves `a x = b` for an n x n row-major `a` by Gaussian elimination with partial pivoting.
    private static func solveLinear(_ a: [Double], _ b: [Double], _ n: Int) -> [Double]? {
        var m = a
        var x = b
        for c in 0 ..< n {
            var piv = c
            for r in (c + 1) ..< n where abs(m[r * n + c]) > abs(m[piv * n + c]) { piv = r }
            if abs(m[piv * n + c]) < 1e-300 { return nil }
            if piv != c {
                for k in 0 ..< n { m.swapAt(c * n + k, piv * n + k) }
                x.swapAt(c, piv)
            }
            for r in (c + 1) ..< n {
                let f = m[r * n + c] / m[c * n + c]
                if f == 0 { continue }
                for k in c ..< n { m[r * n + k] -= f * m[c * n + k] }
                x[r] -= f * x[c]
            }
        }
        for c in stride(from: n - 1, through: 0, by: -1) {
            var s = x[c]
            for k in (c + 1) ..< n { s -= m[c * n + k] * x[k] }
            x[c] = s / m[c * n + c]
        }
        return x
    }

    /// Robust continuous refinement (reference `refine`: soft-L1 with f_scale 0.08, azimuth
    /// in ±720, tilt 0-50, size 0-50). Levenberg-Marquardt on iteratively reweighted residuals.
    static func refine(_ params0: [Double], rows: Rows, clipKw clipInput: Double?, maxNfev: Int = 200) -> [Double] {
        let clipKw = clip(clipInput)
        let np = params0.count
        let planes = np / 3
        let n = rows.y.count
        var p = params0
        for i in stride(from: 1, to: np, by: 3) { p[i] = min(max(p[i], 0.5), LayoutPOA.maxTilt - 0.5) }
        if n == 0 { return normalisedAzimuths(p) }
        var ymax = 1e-3
        for r in 0 ..< n where rows.y[r] > ymax { ymax = rows.y[r] }
        let lo = [-720.0, 0, 0]
        let hi = [720.0, LayoutPOA.maxTilt, 50]
        func clamp(_ v: Double, _ i: Int) -> Double { min(max(v, lo[i % 3]), hi[i % 3]) }

        func evaluate(_ q: [Double]) -> (total: [Double], columns: [[Double]]) {
            var total = [Double](repeating: 0, count: n)
            var columns: [[Double]] = []
            for k in 0 ..< planes {
                let column = LayoutPOA.poaColumn(rows.sun, azimuth: wrapDegrees(q[3 * k]), tilt: q[3 * k + 1], smooth: true)
                let size = q[3 * k + 2]
                for r in 0 ..< n { total[r] += size * column[r] }
                columns.append(column)
            }
            return (total, columns)
        }

        func cost(_ total: [Double]) -> Double {
            var s = 0.0
            for r in 0 ..< n {
                var model = total[r]
                if let clipKw { model = clipKw * LayoutPOA.softmin(total[r] / clipKw) }
                let scaled = (model - rows.y[r]) / ymax / fScale
                s += rows.weight[r] * 2 * (sqrt(1 + scaled * scaled) - 1)
            }
            return 0.5 * fScale * fScale * s
        }

        var (total, columns) = evaluate(p)
        var c0 = cost(total)
        var nfev = 1
        var lambda = 1e-3
        while nfev < maxNfev {
            // Residuals, IRLS weights and the Jacobian at p.
            var res = [Double](repeating: 0, count: n)
            var w = [Double](repeating: 0, count: n)
            var dsoft = [Double](repeating: 0, count: n)
            for r in 0 ..< n {
                var model = total[r]
                var ds = 1.0
                if let clipKw {
                    let x = total[r] / clipKw
                    model = clipKw * LayoutPOA.softmin(x)
                    ds = 1 / (1 + exp(-(1 - x) / 0.01))
                }
                res[r] = (model - rows.y[r]) / ymax
                dsoft[r] = ds / ymax
                let scaled = res[r] / fScale
                w[r] = rows.weight[r] / sqrt(1 + scaled * scaled)
            }
            var jacobian = [[Double]](repeating: [Double](repeating: 0, count: n), count: np)
            for k in 0 ..< planes {
                let az = p[3 * k]
                let tilt = p[3 * k + 1]
                let size = p[3 * k + 2]
                let c = columns[k]
                jacobian[3 * k + 2] = (0 ..< n).map { c[$0] * dsoft[$0] }
                let shifted = LayoutPOA.poaColumn(rows.sun, azimuth: wrapDegrees(az + hAzimuth), tilt: tilt, smooth: true)
                jacobian[3 * k] = (0 ..< n).map { size * (shifted[$0] - c[$0]) / hAzimuth * dsoft[$0] }
                let tiltStep = tilt + hTilt > LayoutPOA.maxTilt ? -hTilt : hTilt
                let tilted = LayoutPOA.poaColumn(rows.sun, azimuth: wrapDegrees(az), tilt: tilt + tiltStep, smooth: true)
                jacobian[3 * k + 1] = (0 ..< n).map { size * (tilted[$0] - c[$0]) / tiltStep * dsoft[$0] }
            }
            var H = [Double](repeating: 0, count: np * np)
            var g = [Double](repeating: 0, count: np)
            for a in 0 ..< np {
                var ga = 0.0
                for r in 0 ..< n { ga += jacobian[a][r] * w[r] * res[r] }
                g[a] = ga
                for b in a ..< np {
                    var s = 0.0
                    for r in 0 ..< n { s += jacobian[a][r] * w[r] * jacobian[b][r] }
                    H[a * np + b] = s
                    H[b * np + a] = s
                }
            }
            // Freeze parameters pinned at a bound whose descent direction points outward;
            // otherwise every clamped step is rejected and the fit runs to max_nfev.
            for a in 0 ..< np {
                let atLo = p[a] <= lo[a % 3] + 1e-9 && g[a] > 0
                let atHi = p[a] >= hi[a % 3] - 1e-9 && g[a] < 0
                guard atLo || atHi else { continue }
                for b in 0 ..< np {
                    H[a * np + b] = 0
                    H[b * np + a] = 0
                }
                H[a * np + a] = 1
                g[a] = 0
            }

            var accepted = false
            var converged = false
            while nfev < maxNfev {
                var A = H
                for a in 0 ..< np { A[a * np + a] += lambda * max(H[a * np + a], 1e-12) }
                guard let step = solveLinear(A, g.map { -$0 }, np) else {
                    lambda *= 10
                    if lambda > 1e12 {
                        converged = true
                        break
                    }
                    continue
                }
                let q = (0 ..< np).map { clamp(p[$0] + step[$0], $0) }
                let trial = evaluate(q)
                nfev += 1
                let c1 = cost(trial.total)
                if c1 < c0 {
                    let rel = (c0 - c1) / max(c0, 1e-300)
                    var moved = 0.0
                    for i in 0 ..< np { moved = max(moved, abs(q[i] - p[i]) / (i % 3 == 2 ? 1 : 10)) }
                    p = q
                    columns = trial.columns
                    total = trial.total
                    c0 = c1
                    lambda = max(lambda / 3, 1e-9)
                    accepted = true
                    if rel < 1e-8 || moved < 1e-6 { converged = true }
                    break
                }
                lambda *= 4
                if lambda > 1e12 {
                    converged = true
                    break
                }
            }
            if !accepted || converged { break }
        }
        return normalisedAzimuths(p)
    }

    static func rmse(_ model: [Double], _ y: [Double]) -> Double {
        var s = 0.0
        for r in 0 ..< y.count { s += (model[r] - y[r]) * (model[r] - y[r]) }
        return sqrt(s / Double(max(y.count, 1)))
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

    /// Refines the best `starts` grid candidates and keeps the lowest RMSE (reference `fit_n`).
    static func fitFromGram(_ rows: Rows, gram: Gram, clipKw: Double?, planes: Int, starts: Int) -> Fitted {
        let candidates = gridSearch(gram, planes: planes)
        var best: (params: [Double], rmseKw: Double)?
        for candidate in candidates.prefix(starts) {
            var start: [Double] = []
            for (j, ii) in candidate.idx.enumerated() {
                start += [combos[ii].azimuth, combos[ii].tilt, candidate.k[j]]
            }
            let params = refine(start, rows: rows, clipKw: clipKw)
            let rm = rmse(modelRows(params, rows: rows, clipKw: clipKw), rows.y)
            if best.map({ rm < $0.rmseKw }) ?? true { best = (params, rm) }
        }
        if let best {
            return Fitted(params: best.params, rmseKw: best.rmseKw, candidates: candidates)
        }
        // No feasible candidate (e.g. no rows): zero-size planes.
        return Fitted(
            params: (0 ..< planes).flatMap { [180 + 90 * Double($0), 20, 0] },
            rmseKw: rmse([Double](repeating: 0, count: rows.y.count), rows.y), candidates: candidates)
    }

    /// Grid-search group per row: rows below 97% of the clip, when clipped; -1 excludes a row.
    static func fitMaskGroup(_ rows: Rows, clipKw clipInput: Double?, groupOf: (Int) -> Int) -> [Int] {
        let clipKw = clip(clipInput)
        return rows.y.indices.map { r in
            if let clipKw, !(rows.y[r] < 0.97 * clipKw) { return -1 }
            return groupOf(r)
        }
    }

    static func angleDiff(_ a: Double, _ b: Double) -> Double {
        abs(wrapDegrees(a - b + 180) - 180)
    }

    /// Planes too similar to be told apart: within 25° azimuth and 10° tilt (reference `distinct`).
    static func distinct(_ planes: [LayoutPlane]) -> Bool {
        for i in planes.indices {
            for j in planes.indices where j > i {
                if angleDiff(planes[i].azimuth, planes[j].azimuth) < 25, abs(planes[i].tilt - planes[j].tilt) < 10 {
                    return false
                }
            }
        }
        return true
    }

    /// Reference `choose_n`: add a plane only for a > 8% held-out gain and a plausible, distinct,
    /// sizeable plane.
    static func choosePlaneCountFrom(_ fits: [Int: [LayoutPlane]], cvNrmse cv: [Int: Double]) -> Int {
        var n = 1
        for m in [2, 3] {
            let gain = (cv[n, default: .nan] - cv[m, default: .nan]) / cv[n, default: .nan]
            let planes = fits[m, default: []]
            let total = planes.reduce(0) { $0 + $1.effectiveKw }
            let artefact = planes.contains { $0.tilt >= LayoutPOA.maxTilt - 2 && $0.effectiveKw < 0.25 * total }
            let minK = planes.map(\.effectiveKw).min() ?? .infinity
            if gain > 0.08, minK > 0.08 * total, distinct(planes), !artefact {
                n = m
            } else {
                break
            }
        }
        return n
    }

    /// Folds by day: a seeded permutation of the days, mod 5 (reference `dayFolds`).
    static func dayFolds(dayCount: Int, rng: () -> Double) -> [Int] {
        var perm = Array(0 ..< dayCount)
        for i in stride(from: dayCount - 1, to: 0, by: -1) {
            let j = Int(floor(rng() * Double(i + 1)))
            perm.swapAt(i, j)
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
            cols, y: rows.y,
            group: fitMaskGroup(rows, clipKw: clipKw) { folds[rows.day[$0]] }, groups: 5)
        try checkCancellation()
        let all = sumGrams(grams)
        var fits: [Int: Fitted] = [:]
        for n in 1 ... 3 {
            fits[n] = fitFromGram(rows, gram: all, clipKw: clipKw, planes: n, starts: n > 1 ? 4 : 3)
            try checkCancellation()
        }

        // Accumulated held-out [sse, count, sum of y] per plane count.
        var sse = [Double](repeating: 0, count: 3)
        var count = [Double](repeating: 0, count: 3)
        var sum = [Double](repeating: 0, count: 3)
        for fold in 0 ..< 5 {
            let isTest = { (r: Int) -> Bool in folds[rows.day[r]] == fold }
            let testCount = rows.y.indices.filter(isTest).count
            if testCount < 50 { continue }
            let train = subsetRows(rows) { !isTest($0) }
            let test = subsetRows(rows, keep: isTest)
            let trainGram = sumGrams(grams, skip: fold)
            for n in 1 ... 3 {
                let fit = fitFromGram(train, gram: trainGram, clipKw: clipKw, planes: n, starts: 2)
                let pred = modelRows(fit.params, rows: test, clipKw: clipKw)
                var foldSSE = 0.0
                var foldSum = 0.0
                for r in test.y.indices {
                    foldSSE += (pred[r] - test.y[r]) * (pred[r] - test.y[r])
                    foldSum += test.y[r]
                }
                sse[n - 1] += foldSSE
                count[n - 1] += Double(test.y.count)
                sum[n - 1] += foldSum
            }
            try checkCancellation()
        }
        var cvNrmse: [Int: Double] = [:]
        for n in 1 ... 3 {
            cvNrmse[n] = sqrt(sse[n - 1] / count[n - 1]) / (sum[n - 1] / count[n - 1])
        }
        let planes = fits.mapValues { toPlanes($0.params) }
        return PlaneCount(
            count: choosePlaneCountFrom(planes, cvNrmse: cvNrmse), cvNrmse: cvNrmse, fits: fits)
    }

    /// Reorders bootstrap planes to match `best` by azimuth and tilt distance (reference `align`).
    static func align(_ boot: [LayoutPlane], best: [LayoutPlane]) -> [LayoutPlane] {
        if best.count == 1 { return boot }
        let perms = best.count == 2
            ? [[0, 1], [1, 0]]
            : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
        func distance(_ i: Int, _ j: Int) -> Double {
            angleDiff(boot[i].azimuth, best[j].azimuth) + 2 * abs(boot[i].tilt - best[j].tilt)
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
        let nDays = rows.days.count
        var out: [[LayoutPlane]] = []
        for _ in 0 ..< rounds {
            var counts = [Double](repeating: 0, count: nDays)
            for _ in 0 ..< nDays { counts[Int(floor(rng() * Double(nDays)))] += 1 }
            let weighted = Rows(
                sun: rows.sun, y: rows.y, day: rows.day, days: rows.days, weight: rows.day.map { counts[$0] })
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

    /// The reference's `clipKw` truthiness: absent, zero and NaN all mean no clip.
    private static func clip(_ clipKw: Double?) -> Double? {
        guard let clipKw, clipKw != 0, !clipKw.isNaN else { return nil }
        return clipKw
    }

    /// `((v % 360) + 360) % 360`, in [0, 360).
    private static func wrapDegrees(_ value: Double) -> Double {
        (value.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }

    private static func normalisedAzimuths(_ params: [Double]) -> [Double] {
        params.enumerated().map { $0.offset % 3 == 0 ? wrapDegrees($0.element) : $0.element }
    }
}
