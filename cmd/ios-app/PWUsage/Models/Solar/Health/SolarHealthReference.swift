import CryptoKit
import Foundation

/// One plane of the health reference: what a healthy array of this size should produce.
struct SolarHealthPlane: Codable, Equatable, Sendable {
    let azimuth: Double
    let tilt: Double
    /// Effective size: nameplate times the detector's healthy derate, or the detected plane's own.
    let effectiveKw: Double
}

/// A direction faces share: faces pointing within `separationDegrees` of each other cannot be told
/// apart in one production series, so they share one capacity factor.
struct SolarHealthDirection: Equatable, Sendable {
    let azimuth: Double
}

/// The fixed layout every year is compared with. With a manual layout it is the entered faces at
/// nameplate, one plane per face and only the systems installed by each date. Without one it is the
/// detected geometry, which the pass scales to the site's best year.
struct SolarHealthReference: Equatable, Sendable {
    enum Source: String, Codable, Sendable { case manual, detected }

    /// The planes in force from `from` until the next step.
    struct Step: Equatable, Sendable {
        let from: Date
        let planes: [SolarHealthPlane]
    }

    /// Faces closer than this in azimuth share a factor.
    static let separationDegrees = 60.0

    let source: Source
    let steps: [Step]

    /// Nil when there is nothing to compare with: no entered face with a direction and no detected plane.
    init?(manual: ManualSolarLayout?, detected: DetectedSolarLayout?) {
        if let manual, manual.isValid {
            let installDates = Set(manual.systems.compactMap(\.installDate)).sorted()
            let steps = ([Date.distantPast] + installDates).map { date in
                Step(
                    from: date,
                    planes: manual.solarLayout(detected: detected, on: date, detectedAt: nil)?.planes.map {
                        SolarHealthPlane(
                            azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.dcKwp * SolarLayoutDetector.derate)
                    } ?? [])
            }
            guard steps.contains(where: { !$0.planes.isEmpty }) else { return nil }
            self.init(source: .manual, steps: steps)
        } else if let detected, !detected.planes.isEmpty {
            let planes = detected.planes.map {
                SolarHealthPlane(azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.effectiveKw)
            }
            self.init(source: .detected, steps: [Step(from: .distantPast, planes: planes)])
        } else {
            return nil
        }
    }

    init(source: Source, steps: [Step]) {
        self.source = source
        self.steps = steps
    }

    func planes(on date: Date) -> [SolarHealthPlane] {
        steps.last { $0.from <= date }?.planes ?? []
    }

    /// Index of the step in force on `date`, nil before the first.
    func stepIndex(on date: Date) -> Int? {
        steps.lastIndex { $0.from <= date }
    }

    /// Identifies the reference in the cache: any change to a face, a date or the source changes it.
    var key: String {
        let text = ([source.rawValue] + steps.map { step in
            let from = step.from == .distantPast ? "start" : String(Int(step.from.timeIntervalSince1970))
            let planes = step.planes.map { plane in
                [plane.azimuth, plane.tilt, plane.effectiveKw].map { String(format: "%.3f", $0) }.joined(separator: ",")
            }
            return "\(from)>" + planes.joined(separator: ";")
        }).joined(separator: "|")
        return SHA256.hash(data: Data(text.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
    }

    /// Every distinct plane across the steps.
    var allPlanes: [SolarHealthPlane] {
        var seen: [SolarHealthPlane] = []
        for plane in steps.flatMap(\.planes) where !seen.contains(plane) { seen.append(plane) }
        return seen
    }

    /// The directions the faces point in, by increasing azimuth.
    var directions: [SolarHealthDirection] { groups.map { SolarHealthDirection(azimuth: $0.azimuth) } }

    /// The direction carrying the most capacity, where a shared factor is reported.
    var dominantDirection: SolarHealthDirection {
        var kw: [Int: Double] = [:]
        for plane in allPlanes { kw[directionIndex(of: plane), default: 0] += plane.effectiveKw }
        let best = kw.max { $0.value < $1.value }?.key ?? 0
        return directions.indices.contains(best) ? directions[best] : SolarHealthDirection(azimuth: 180)
    }

    /// Index into `directions` of the group a plane belongs to.
    func directionIndex(of plane: SolarHealthPlane) -> Int {
        let wrapped = LayoutFit.wrapDegrees(plane.azimuth)
        return groups.firstIndex { $0.members.contains(wrapped) } ?? 0
    }

    private struct Group {
        let azimuth: Double
        var members: [Double]
    }

    /// Single-linkage clusters of the planes' azimuths around the circle.
    private var groups: [Group] {
        let azimuths = Set(allPlanes.map { LayoutFit.wrapDegrees($0.azimuth) }).sorted()
        guard azimuths.count > 1 else { return azimuths.map { Group(azimuth: $0, members: [$0]) } }
        let count = azimuths.count
        func gap(after index: Int) -> Double {
            index == count - 1 ? azimuths[0] + 360 - azimuths[index] : azimuths[index + 1] - azimuths[index]
        }
        guard let firstCut = (0 ..< count).first(where: { gap(after: $0) >= Self.separationDegrees }) else {
            return [Group(azimuth: Self.circularMean(azimuths), members: azimuths)]
        }
        var runs: [[Double]] = [[]]
        for offset in 1 ... count {
            let index = (firstCut + offset) % count
            runs[runs.count - 1].append(azimuths[index])
            if gap(after: index) >= Self.separationDegrees, offset < count { runs.append([]) }
        }
        return runs.map { Group(azimuth: Self.circularMean($0), members: $0) }
            .sorted { $0.azimuth < $1.azimuth }
    }

    private static func circularMean(_ azimuths: [Double]) -> Double {
        let radians = Double.pi / 180
        let east = azimuths.reduce(0) { $0 + sin($1 * radians) }
        let north = azimuths.reduce(0) { $0 + cos($1 * radians) }
        return LayoutFit.wrapDegrees(atan2(east, north) / radians)
    }
}
