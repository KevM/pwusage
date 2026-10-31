import Foundation

/// Plane fitting (port of the detector's `fit.ts`). The exhaustive azimuth x tilt grid is solved
/// linearly through Gram matrices; the best candidates are refined continuously with a robust
/// (soft-L1) Levenberg-Marquardt fit, clipping included as a smooth cap. Gram matrices are
/// accumulated per cross-validation fold so the CV reuses one pass over the rows.
///
/// This file holds the data types, the grid search and the Gram accumulation. The continuous
/// refinement lives in `layout-fit-refine.swift`, the plane-count selection and bootstrap in
/// `layout-fit-plane-count.swift`.
enum LayoutFit {
    static let fScale = 0.08
    static let hAzimuth = 0.5
    static let hTilt = 0.25

    /// Grid (azimuth, tilt) combinations: 36 azimuths at each tilt above 0°, and one flat plane.
    static let combos: [(azimuth: Double, tilt: Double)] = stride(from: 0, through: 50, by: 5)
        .flatMap { tilt -> [(azimuth: Double, tilt: Double)] in
            let tiltValue = Double(tilt)
            return tilt > 0
                ? (0 ..< 36).map { (azimuth: Double($0) * 10, tilt: tiltValue) }
                : [(azimuth: 180, tilt: tiltValue)]
        }

    /// Rows used for fitting: geometry, measured kW (`y` in the reference), day index and a
    /// weight (bootstrap counts).
    struct Rows: Sendable {
        var sun: LayoutSunArrays
        var powerKw: [Double]
        var day: [Int]
        var days: [String]
        var weight: [Double]
    }

    /// Gram matrix of one group (reference `G`, `b`, `yy`): `normal` is the m x m row-major
    /// normal matrix, `moment` the right-hand side and `sumSquares` the sum of squared targets.
    struct Gram: Sendable {
        var normal: [Double]
        var moment: [Double]
        var sumSquares: Double

        init(size: Int) {
            normal = [Double](repeating: 0, count: size * size)
            moment = [Double](repeating: 0, count: size)
            sumSquares = 0
        }

        func diagonal(_ index: Int) -> Double { normal[index * moment.count + index] }
    }

    /// A grid candidate: the sum of squared errors, the combo indices and the plane sizes.
    struct Candidate: Sendable {
        let sse: Double
        let idx: [Int]
        let sizes: [Double]
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
            var mixed = state
            mixed = (mixed ^ (mixed >> 15)) &* (mixed | 1)
            mixed = mixed ^ (mixed &+ ((mixed ^ (mixed >> 7)) &* (mixed | 61)))
            return Double(mixed ^ (mixed >> 14)) / 4_294_967_296
        }
    }

    /// Rows of `series` that are selected and have a finite measurement.
    static func fitRows(_ series: LayoutSeries, selected: [Bool]) -> Rows {
        let indices = series.indices.filter { selected[$0] && series[$0].powerKw.isFinite }
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
            powerKw: indices.map { series[$0].powerKw }, day: day, days: days,
            weight: [Double](repeating: 1, count: indices.count))
    }

    /// The rows for which `keep` holds, in order.
    static func subsetRows(_ rows: Rows, keep: (Int) -> Bool) -> Rows {
        let indices = rows.powerKw.indices.filter(keep)
        return Rows(
            sun: rows.sun.subset(indices), powerKw: indices.map { rows.powerKw[$0] },
            day: indices.map { rows.day[$0] }, days: rows.days, weight: indices.map { rows.weight[$0] })
    }

    /// Grid columns (kW per kW for every combo) for a set of rows, stored as Float like the reference.
    @_optimize(speed)
    static func gridColumns(_ rows: Rows) -> [[Float]] {
        combos.map { combo in
            LayoutPOA.poaColumn(rows.sun, azimuth: combo.azimuth, tilt: combo.tilt).map { Float($0) }
        }
    }

    /// Gram matrices per group (`group[row]` in 0..<groups, -1 excluded): the upper triangle of the
    /// sum of outer products of each row's grid values, mirrored. Rows are processed in
    /// cache-sized blocks laid out row-major.
    @_optimize(speed)
    static func groupGrams(_ cols: [[Float]], powerKw: [Double], group: [Int], groups: Int) -> [Gram] {
        let width = cols.count
        var out = (0 ..< groups).map { _ in Gram(size: width) }
        let blockSize = 256
        var block = [Double](repeating: 0, count: blockSize * width)
        for target in 0 ..< groups {
            var pending: [Int] = []
            for row in powerKw.indices where group[row] == target {
                let off = pending.count * width
                for col in 0 ..< width { block[off + col] = Double(cols[col][row]) }
                pending.append(row)
                if pending.count == blockSize {
                    accumulate(&out[target], block: block, rows: pending, powerKw: powerKw, width: width)
                    pending.removeAll(keepingCapacity: true)
                }
            }
            accumulate(&out[target], block: block, rows: pending, powerKw: powerKw, width: width)
            for col in 0 ..< width {
                for other in (col + 1) ..< width {
                    out[target].normal[other * width + col] = out[target].normal[col * width + other]
                }
            }
        }
        return out
    }

    /// Adds the block's rows (row-major, `width` per row) into `gram`, row by row.
    private static func accumulate(_ gram: inout Gram, block: [Double], rows: [Int], powerKw: [Double], width: Int) {
        block.withUnsafeBufferPointer { blockPtr in
            gram.normal.withUnsafeMutableBufferPointer { normal in
                gram.moment.withUnsafeMutableBufferPointer { moment in
                    for entry in rows.indices {
                        let off = entry * width
                        let measured = powerKw[rows[entry]]
                        gram.sumSquares += measured * measured
                        for col in 0 ..< width {
                            let lhs = blockPtr[off + col]
                            if lhs == 0 { continue }
                            moment[col] += lhs * measured
                            let rowBase = col * width
                            for other in col ..< width { normal[rowBase + other] += lhs * blockPtr[off + other] }
                        }
                    }
                }
            }
        }
    }

    /// Sum of the groups' Grams, leaving out group `skip` when given.
    static func sumGrams(_ grams: [Gram], skip: Int = -1) -> Gram {
        var out = Gram(size: grams[0].moment.count)
        for (index, gram) in grams.enumerated() where index != skip {
            for entry in out.normal.indices { out.normal[entry] += gram.normal[entry] }
            for entry in out.moment.indices { out.moment[entry] += gram.moment[entry] }
            out.sumSquares += gram.sumSquares
        }
        return out
    }

    /// Solves a 3x3 system (row-major `matrix`) by Cramer's rule, nil when singular.
    private static func solve3(_ matrix: [Double], _ rhs: [Double]) -> [Double]? {
        let (a00, a01, a02) = (matrix[0], matrix[1], matrix[2])
        let (a10, a11, a12) = (matrix[3], matrix[4], matrix[5])
        let (a20, a21, a22) = (matrix[6], matrix[7], matrix[8])
        let det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
        guard det.isFinite, det != 0 else { return nil }
        let (rhs0, rhs1, rhs2) = (rhs[0], rhs[1], rhs[2])
        let first =
            (rhs0 * (a11 * a22 - a12 * a21) - a01 * (rhs1 * a22 - a12 * rhs2) + a02 * (rhs1 * a21 - a11 * rhs2)) / det
        let second =
            (a00 * (rhs1 * a22 - a12 * rhs2) - rhs0 * (a10 * a22 - a12 * a20) + a02 * (a10 * rhs2 - rhs1 * a20)) / det
        let third =
            (a00 * (a11 * rhs2 - rhs1 * a21) - a01 * (a10 * rhs2 - rhs1 * a20) + rhs0 * (a10 * a21 - a11 * a20)) / det
        return [first, second, third]
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
        if planes == 1 { return Array(sortedBySSE(singlePlaneCandidates(gram)).prefix(top)) }
        let pairs = sortedBySSE(pairCandidates(gram))
        if planes == 2 { return Array(pairs.prefix(top)) }

        // Three planes: extend the best 60 pairs with every third column.
        let extended = pairs.prefix(60).compactMap { bestTriple(gram, extending: $0) }
        var seen = Set<String>()
        var unique: [Candidate] = []
        for candidate in sortedBySSE(extended) {
            let key = candidate.idx.map(String.init).joined(separator: ",")
            if seen.insert(key).inserted { unique.append(candidate) }
        }
        return Array(unique.prefix(top))
    }

    /// Every single-plane candidate, in combo order.
    private static func singlePlaneCandidates(_ gram: Gram) -> [Candidate] {
        var candidates: [Candidate] = []
        for index in 0 ..< gram.moment.count {
            let moment = gram.moment[index]
            let diagonal = gram.diagonal(index)
            let size = max(diagonal > 0 ? moment / diagonal : 0, 0)
            let sse = gram.sumSquares - 2 * size * moment + size * size * diagonal
            candidates.append(Candidate(sse: sse, idx: [index], sizes: [size]))
        }
        return candidates
    }

    /// Every feasible two-plane candidate, in combo-pair order.
    private static func pairCandidates(_ gram: Gram) -> [Candidate] {
        let width = gram.moment.count
        let moment = gram.moment
        var pairs: [Candidate] = []
        for first in 0 ..< width {
            for second in (first + 1) ..< width {
                let gii = gram.diagonal(first)
                let gjj = gram.diagonal(second)
                let gij = gram.normal[first * width + second]
                let det = gii * gjj - gij * gij
                let sizeI = (gjj * moment[first] - gij * moment[second]) / det
                let sizeJ = (gii * moment[second] - gij * moment[first]) / det
                let sse = gram.sumSquares - 2 * (sizeI * moment[first] + sizeJ * moment[second])
                    + sizeI * sizeI * gii + 2 * sizeI * sizeJ * gij + sizeJ * sizeJ * gjj
                if sizeI < 0 || sizeJ < 0 || !sse.isFinite || det < 1e-9 * gii * gjj { continue }
                pairs.append(Candidate(sse: sse, idx: [first, second], sizes: [sizeI, sizeJ]))
            }
        }
        return pairs
    }

    /// The best three-plane extension of `pair` over every other column, sorted by combo index.
    private static func bestTriple(_ gram: Gram, extending pair: Candidate) -> Candidate? {
        let (first, second) = (pair.idx[0], pair.idx[1])
        var best: Candidate?
        for third in 0 ..< gram.moment.count where third != first && third != second {
            guard let triple = tripleCandidate(gram, ids: [first, second, third]) else { continue }
            if triple.sse < (best?.sse ?? .infinity) { best = triple }
        }
        guard let best else { return nil }
        let order = [0, 1, 2].sorted { best.idx[$0] < best.idx[$1] }
        return Candidate(sse: best.sse, idx: order.map { best.idx[$0] }, sizes: order.map { best.sizes[$0] })
    }

    /// The exact three-plane solution for the combos `ids`, nil when singular, negative or not finite.
    private static func tripleCandidate(_ gram: Gram, ids: [Int]) -> Candidate? {
        let width = gram.moment.count
        let matrix = ids.flatMap { row in ids.map { col in gram.normal[row * width + col] + (row == col ? 1e-12 : 0) } }
        let rhs = ids.map { gram.moment[$0] }
        guard let sizes = solve3(matrix, rhs), !sizes.contains(where: { $0 < 0 }) else { return nil }
        var quad = 0.0
        for row in 0 ..< 3 {
            for col in 0 ..< 3 { quad += sizes[row] * matrix[row * 3 + col] * sizes[col] }
        }
        let sse = gram.sumSquares - 2 * (sizes[0] * rhs[0] + sizes[1] * rhs[1] + sizes[2] * rhs[2]) + quad
        return sse.isFinite ? Candidate(sse: sse, idx: ids, sizes: sizes) : nil
    }

    /// Model kW for packed params [azimuth, tilt, kW, ...] over the rows.
    @_optimize(speed)
    static func modelRows(_ params: [Double], rows: Rows, clipKw clipInput: Double?) -> [Double] {
        let count = rows.powerKw.count
        var total = [Double](repeating: 0, count: count)
        for base in stride(from: 0, to: params.count, by: 3) {
            let column = LayoutPOA.poaColumn(
                rows.sun, azimuth: wrapDegrees(params[base]), tilt: params[base + 1], smooth: true)
            let size = params[base + 2]
            for row in 0 ..< count { total[row] += size * column[row] }
        }
        if let clipKw = clip(clipInput) {
            for row in 0 ..< count { total[row] = clipKw * LayoutPOA.softmin(total[row] / clipKw) }
        }
        return total
    }

    /// Refines the best `starts` grid candidates and keeps the lowest RMSE (reference `fit_n`).
    @_optimize(speed)
    static func fitFromGram(_ rows: Rows, gram: Gram, clipKw: Double?, planes: Int, starts: Int) -> Fitted {
        let candidates = gridSearch(gram, planes: planes)
        var best: (params: [Double], rmseKw: Double)?
        for candidate in candidates.prefix(starts) {
            var start: [Double] = []
            for (position, comboIndex) in candidate.idx.enumerated() {
                start += [combos[comboIndex].azimuth, combos[comboIndex].tilt, candidate.sizes[position]]
            }
            let params = refine(start, rows: rows, clipKw: clipKw)
            let candidateRmse = rmse(modelRows(params, rows: rows, clipKw: clipKw), rows.powerKw)
            if best.map({ candidateRmse < $0.rmseKw }) ?? true { best = (params, candidateRmse) }
        }
        if let best {
            return Fitted(params: best.params, rmseKw: best.rmseKw, candidates: candidates)
        }
        // No feasible candidate (e.g. no rows): zero-size planes.
        return Fitted(
            params: (0 ..< planes).flatMap { [180 + 90 * Double($0), 20, 0] },
            rmseKw: rmse([Double](repeating: 0, count: rows.powerKw.count), rows.powerKw), candidates: candidates)
    }

    /// The reference's `clipKw` truthiness: absent, zero and NaN all mean no clip.
    static func clip(_ clipKw: Double?) -> Double? {
        guard let clipKw, clipKw != 0, !clipKw.isNaN else { return nil }
        return clipKw
    }

    /// `((v % 360) + 360) % 360`, in [0, 360).
    static func wrapDegrees(_ value: Double) -> Double {
        (value.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }
}
