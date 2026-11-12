import Foundation

/// Least-squares capacity: the scale factor of measured production to the reference model.
enum SolarHealthFit {
    /// The factors for one set of rows.
    struct Scales: Equatable, Sendable {
        /// One factor for the whole site.
        let site: Double
        /// One factor per direction, nil when the directions cannot be told apart in these rows.
        let perDirection: [Double]?
    }

    /// Fewer rows than this give no fit.
    static let minRows = 100
    /// The normalised determinant of the direction columns below which they count as inseparable
    /// (1 means independent, 0 means one is a multiple of another).
    static let minIndependence = 0.05

    /// `measured ≈ site * Σ models`, and `measured ≈ Σ factor_d * models[d]` when the directions are
    /// independent enough and every factor is positive. `models` holds one array per direction,
    /// indexed like `measured`; `rows` picks the rows to fit.
    static func scales(measured: [Double], models: [[Double]], rows: [Int]) -> Scales? {
        guard rows.count >= minRows else { return nil }
        var numerator = 0.0
        var denominator = 0.0
        for row in rows {
            let total = models.reduce(0) { $0 + $1[row] }
            numerator += measured[row] * total
            denominator += total * total
        }
        guard denominator > 0, numerator > 0 else { return nil }
        return Scales(site: numerator / denominator, perDirection: perDirection(measured, models, rows))
    }

    private static func perDirection(_ measured: [Double], _ models: [[Double]], _ rows: [Int]) -> [Double]? {
        let count = models.count
        guard count > 1 else { return nil }
        var normal = [[Double]](repeating: [Double](repeating: 0, count: count), count: count)
        var moment = [Double](repeating: 0, count: count)
        for row in rows {
            for first in 0 ..< count {
                moment[first] += models[first][row] * measured[row]
                for second in first ..< count { normal[first][second] += models[first][row] * models[second][row] }
            }
        }
        for first in 0 ..< count {
            for second in 0 ..< first { normal[first][second] = normal[second][first] }
        }
        guard (0 ..< count).allSatisfy({ normal[$0][$0] > 0 }) else { return nil }
        var correlation = normal
        for first in 0 ..< count {
            for second in 0 ..< count {
                correlation[first][second] = normal[first][second] / (normal[first][first] * normal[second][second]).squareRoot()
            }
        }
        guard let independence = solve(correlation, [Double](repeating: 0, count: count))?.determinant,
              independence >= minIndependence,
              let factors = solve(normal, moment)?.solution, factors.allSatisfy({ $0 > 0 }) else { return nil }
        return factors
    }

    /// Gaussian elimination with partial pivoting; nil when singular.
    private static func solve(_ matrix: [[Double]], _ rhs: [Double]) -> (solution: [Double], determinant: Double)? {
        var rowsData = matrix
        var right = rhs
        let size = rhs.count
        var determinant = 1.0
        for column in 0 ..< size {
            guard let pivot = (column ..< size).max(by: { abs(rowsData[$0][column]) < abs(rowsData[$1][column]) }),
                  abs(rowsData[pivot][column]) > 1e-12 else { return nil }
            if pivot != column {
                rowsData.swapAt(pivot, column)
                right.swapAt(pivot, column)
                determinant = -determinant
            }
            determinant *= rowsData[column][column]
            for below in (column + 1) ..< size {
                let ratio = rowsData[below][column] / rowsData[column][column]
                for other in column ..< size { rowsData[below][other] -= ratio * rowsData[column][other] }
                right[below] -= ratio * right[column]
            }
        }
        var solution = [Double](repeating: 0, count: size)
        for row in stride(from: size - 1, through: 0, by: -1) {
            var sum = right[row]
            for other in (row + 1) ..< size { sum -= rowsData[row][other] * solution[other] }
            solution[row] = sum / rowsData[row][row]
        }
        return (solution, determinant)
    }
}
