import Foundation

extension SolarHealthYearFit {
    /// The reference model for every row: kW per direction, with the planes of the system set in
    /// force on each row's day. Rows before the first system have no reference.
    static func referenceModels(rows: LayoutFit.Rows, place: Place) -> (models: [[Double]], covered: [Bool]) {
        let reference = place.reference
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = place.timeZone
        let stepOfDay = rows.days.map { day -> Int? in
            let parts = day.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3,
                  let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
            else { return nil }
            return reference.stepIndex(on: date)
        }
        var models = [[Double]](
            repeating: [Double](repeating: 0, count: rows.powerKw.count), count: reference.directions.count)
        var covered = [Bool](repeating: false, count: rows.powerKw.count)
        for (stepIndex, step) in reference.steps.enumerated() where !step.planes.isEmpty {
            let indices = rows.powerKw.indices.filter { stepOfDay[rows.day[$0]] == stepIndex }
            guard !indices.isEmpty else { continue }
            let subset = LayoutFit.subsetRows(rows) { stepOfDay[rows.day[$0]] == stepIndex }
            for plane in step.planes {
                let column = LayoutFit.modelRows(
                    [plane.azimuth, plane.tilt, plane.effectiveKw], rows: subset, clipKw: nil)
                let direction = reference.directionIndex(of: plane)
                for (position, row) in indices.enumerated() { models[direction][row] += column[position] }
            }
            for row in indices { covered[row] = true }
        }
        return (models, covered)
    }
}
