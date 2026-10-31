import Foundation

/// Continuous refinement of the fitted planes (reference `refine`).
extension LayoutFit {
    /// The fixed inputs of one refinement and the model evaluations over them.
    private struct RefineProblem {
        let rows: Rows
        let clipKw: Double?
        let yMax: Double
        let planes: Int
        let paramCount: Int
        let count: Int
        let lower = [-720.0, 0, 0]
        let upper = [720.0, LayoutPOA.maxTilt, 50]

        func clamp(_ value: Double, _ index: Int) -> Double {
            min(max(value, lower[index % 3]), upper[index % 3])
        }

        @_optimize(speed)
        func evaluate(_ params: [Double]) -> (total: [Double], columns: [[Double]]) {
            var total = [Double](repeating: 0, count: count)
            var columns: [[Double]] = []
            for plane in 0 ..< planes {
                let column = LayoutPOA.poaColumn(
                    rows.sun, azimuth: wrapDegrees(params[3 * plane]), tilt: params[3 * plane + 1], smooth: true)
                let size = params[3 * plane + 2]
                for row in 0 ..< count { total[row] += size * column[row] }
                columns.append(column)
            }
            return (total, columns)
        }

        @_optimize(speed)
        func cost(_ total: [Double]) -> Double {
            var sum = 0.0
            for row in 0 ..< count {
                var model = total[row]
                if let clipKw { model = clipKw * LayoutPOA.softmin(total[row] / clipKw) }
                let scaled = (model - rows.powerKw[row]) / yMax / fScale
                sum += rows.weight[row] * 2 * (sqrt(1 + scaled * scaled) - 1)
            }
            return 0.5 * fScale * fScale * sum
        }

        /// Residuals, IRLS weights and the derivative of the clip cap at the current model.
        @_optimize(speed)
        func linearisation(_ total: [Double]) -> Linearisation {
            var residuals = [Double](repeating: 0, count: count)
            var weights = [Double](repeating: 0, count: count)
            var dsoft = [Double](repeating: 0, count: count)
            for row in 0 ..< count {
                var model = total[row]
                var slope = 1.0
                if let clipKw {
                    let ratio = total[row] / clipKw
                    model = clipKw * LayoutPOA.softmin(ratio)
                    slope = 1 / (1 + exp(-(1 - ratio) / 0.01))
                }
                residuals[row] = (model - rows.powerKw[row]) / yMax
                dsoft[row] = slope / yMax
                let scaled = residuals[row] / fScale
                weights[row] = rows.weight[row] / sqrt(1 + scaled * scaled)
            }
            return Linearisation(residuals: residuals, weights: weights, dsoft: dsoft)
        }

        /// Jacobian rows (one per parameter) by forward differences on the smooth POA columns.
        @_optimize(speed)
        func jacobian(_ params: [Double], columns: [[Double]], dsoft: [Double]) -> [[Double]] {
            var jacobian = [[Double]](repeating: [Double](repeating: 0, count: count), count: paramCount)
            for plane in 0 ..< planes {
                let azimuth = params[3 * plane]
                let tilt = params[3 * plane + 1]
                let size = params[3 * plane + 2]
                let column = columns[plane]
                jacobian[3 * plane + 2] = (0 ..< count).map { column[$0] * dsoft[$0] }
                let shifted = LayoutPOA.poaColumn(
                    rows.sun, azimuth: wrapDegrees(azimuth + hAzimuth), tilt: tilt, smooth: true)
                jacobian[3 * plane] = (0 ..< count).map {
                    size * (shifted[$0] - column[$0]) / hAzimuth * dsoft[$0]
                }
                let tiltStep = tilt + hTilt > LayoutPOA.maxTilt ? -hTilt : hTilt
                let tilted = LayoutPOA.poaColumn(
                    rows.sun, azimuth: wrapDegrees(azimuth), tilt: tilt + tiltStep, smooth: true)
                jacobian[3 * plane + 1] = (0 ..< count).map {
                    size * (tilted[$0] - column[$0]) / tiltStep * dsoft[$0]
                }
            }
            return jacobian
        }

        /// Gauss-Newton normal matrix (`hessian`, row-major) and `gradient` for the IRLS weights.
        @_optimize(speed)
        func normalEquations(
            _ jacobian: [[Double]], weights: [Double], residuals: [Double]
        ) -> (hessian: [Double], gradient: [Double]) {
            var hessian = [Double](repeating: 0, count: paramCount * paramCount)
            var gradient = [Double](repeating: 0, count: paramCount)
            for first in 0 ..< paramCount {
                var gradSum = 0.0
                for row in 0 ..< count { gradSum += jacobian[first][row] * weights[row] * residuals[row] }
                gradient[first] = gradSum
                for second in first ..< paramCount {
                    var sum = 0.0
                    for row in 0 ..< count { sum += jacobian[first][row] * weights[row] * jacobian[second][row] }
                    hessian[first * paramCount + second] = sum
                    hessian[second * paramCount + first] = sum
                }
            }
            return (hessian, gradient)
        }

        /// Freezes parameters pinned at a bound whose descent direction points outward;
        /// otherwise every clamped step is rejected and the fit runs to max_nfev.
        func freezePinned(_ hessian: inout [Double], _ gradient: inout [Double], params: [Double]) {
            for first in 0 ..< paramCount {
                let atLower = params[first] <= lower[first % 3] + 1e-9 && gradient[first] > 0
                let atUpper = params[first] >= upper[first % 3] - 1e-9 && gradient[first] < 0
                guard atLower || atUpper else { continue }
                for second in 0 ..< paramCount {
                    hessian[first * paramCount + second] = 0
                    hessian[second * paramCount + first] = 0
                }
                hessian[first * paramCount + first] = 1
                gradient[first] = 0
            }
        }

        /// Largest scaled parameter move between `from` and `to` (azimuth and tilt per 10, size per 1).
        func scaledMove(from before: [Double], to after: [Double]) -> Double {
            var moved = 0.0
            for index in 0 ..< paramCount {
                moved = max(moved, abs(after[index] - before[index]) / (index % 3 == 2 ? 1 : 10))
            }
            return moved
        }

        /// Damped steps from the current state until one lowers the cost (accepted) or the damping
        /// gives up (converged); `state` is updated in place on acceptance.
        @_optimize(speed)
        func levenbergMarquardtStep(
            _ state: inout RefineState, hessian: [Double], gradient: [Double], maxNfev: Int
        ) -> (accepted: Bool, converged: Bool) {
            while state.nfev < maxNfev {
                var damped = hessian
                for diag in 0 ..< paramCount {
                    damped[diag * paramCount + diag] += state.lambda * max(hessian[diag * paramCount + diag], 1e-12)
                }
                guard let step = solveLinear(damped, gradient.map { -$0 }, paramCount) else {
                    state.lambda *= 10
                    if state.lambda > 1e12 { return (false, true) }
                    continue
                }
                let trialParams = (0 ..< paramCount).map { clamp(state.params[$0] + step[$0], $0) }
                let trial = evaluate(trialParams)
                state.nfev += 1
                let trialCost = cost(trial.total)
                if trialCost < state.cost {
                    let rel = (state.cost - trialCost) / max(state.cost, 1e-300)
                    let moved = scaledMove(from: state.params, to: trialParams)
                    state.params = trialParams
                    state.columns = trial.columns
                    state.total = trial.total
                    state.cost = trialCost
                    state.lambda = max(state.lambda / 3, 1e-9)
                    return (true, rel < 1e-8 || moved < 1e-6)
                }
                state.lambda *= 4
                if state.lambda > 1e12 { return (false, true) }
            }
            return (false, false)
        }
    }

    /// Residuals, IRLS weights and the derivative of the clip cap (`dsoft`) per row.
    private struct Linearisation {
        let residuals: [Double]
        let weights: [Double]
        let dsoft: [Double]
    }

    /// The moving state of a refinement: parameters, their model, cost, damping and evaluations used.
    private struct RefineState {
        var params: [Double]
        var total: [Double]
        var columns: [[Double]]
        var cost: Double
        var nfev = 1
        var lambda = 1e-3
    }

    /// Solves `matrix x = rhs` for an n x n row-major `matrix` by Gaussian elimination with partial pivoting.
    static func solveLinear(_ matrix: [Double], _ rhs: [Double], _ size: Int) -> [Double]? {
        var work = matrix
        var solution = rhs
        for pivotCol in 0 ..< size {
            var pivot = pivotCol
            for row in (pivotCol + 1) ..< size
                where abs(work[row * size + pivotCol]) > abs(work[pivot * size + pivotCol]) {
                pivot = row
            }
            if abs(work[pivot * size + pivotCol]) < 1e-300 { return nil }
            if pivot != pivotCol {
                for col in 0 ..< size { work.swapAt(pivotCol * size + col, pivot * size + col) }
                solution.swapAt(pivotCol, pivot)
            }
            for row in (pivotCol + 1) ..< size {
                let factor = work[row * size + pivotCol] / work[pivotCol * size + pivotCol]
                if factor == 0 { continue }
                for col in pivotCol ..< size { work[row * size + col] -= factor * work[pivotCol * size + col] }
                solution[row] -= factor * solution[pivotCol]
            }
        }
        for pivotCol in stride(from: size - 1, through: 0, by: -1) {
            var sum = solution[pivotCol]
            for col in (pivotCol + 1) ..< size { sum -= work[pivotCol * size + col] * solution[col] }
            solution[pivotCol] = sum / work[pivotCol * size + pivotCol]
        }
        return solution
    }

    /// Robust continuous refinement (reference `refine`: soft-L1 with f_scale 0.08, azimuth
    /// in ±720, tilt 0-50, size 0-50). Levenberg-Marquardt on iteratively reweighted residuals.
    @_optimize(speed)
    static func refine(_ params0: [Double], rows: Rows, clipKw clipInput: Double?, maxNfev: Int = 200) -> [Double] {
        let paramCount = params0.count
        let count = rows.powerKw.count
        var params = params0
        for tiltIndex in stride(from: 1, to: paramCount, by: 3) {
            params[tiltIndex] = min(max(params[tiltIndex], 0.5), LayoutPOA.maxTilt - 0.5)
        }
        if count == 0 { return normalisedAzimuths(params) }
        var yMax = 1e-3
        for row in 0 ..< count where rows.powerKw[row] > yMax { yMax = rows.powerKw[row] }
        let problem = RefineProblem(
            rows: rows, clipKw: clip(clipInput), yMax: yMax, planes: paramCount / 3,
            paramCount: paramCount, count: count)

        let initial = problem.evaluate(params)
        var state = RefineState(
            params: params, total: initial.total, columns: initial.columns, cost: problem.cost(initial.total))
        while state.nfev < maxNfev {
            // Residuals, IRLS weights and the Jacobian at the current parameters.
            let lin = problem.linearisation(state.total)
            let jacobian = problem.jacobian(state.params, columns: state.columns, dsoft: lin.dsoft)
            var (hessian, gradient) = problem.normalEquations(jacobian, weights: lin.weights, residuals: lin.residuals)
            problem.freezePinned(&hessian, &gradient, params: state.params)
            let outcome = problem.levenbergMarquardtStep(
                &state, hessian: hessian, gradient: gradient, maxNfev: maxNfev)
            if !outcome.accepted || outcome.converged { break }
        }
        return normalisedAzimuths(state.params)
    }

    static func normalisedAzimuths(_ params: [Double]) -> [Double] {
        params.enumerated().map { $0.offset % 3 == 0 ? wrapDegrees($0.element) : $0.element }
    }
}
