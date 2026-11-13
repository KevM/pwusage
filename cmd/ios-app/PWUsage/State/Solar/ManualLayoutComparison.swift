import Foundation

/// Where the entered layout and the detected one disagree. Informational: a flag never blocks a save.
enum ManualLayoutFlag: Equatable, Sendable {
    case azimuthOutsideDetectedRange(face: UUID, entered: Double, detected: Double)
    case tiltOutsideDetectedRange(face: UUID, entered: Double, detected: Double)
    case directionCountDiffers(entered: Int, detected: Int)
    case capacityOutsideBand(fittedKw: Double, nameplateKw: Double)
}

enum ManualLayoutComparison {
    /// How far outside a detected 90% range an entered angle may fall before it is flagged.
    static let angleAllowance = 5.0
    /// Faces whose directions are within this many degrees point the same way.
    static let sameDirectionSpread = 25.0
    /// The detector assumes 85% for a healthy system.
    static let healthyBand = 0.6 ... 0.9

    static func flags(
        manual: ManualSolarLayout, detected: DetectedSolarLayout?, on date: Date
    ) -> [ManualLayoutFlag] {
        guard let detected, detected.status == .detected, !detected.planes.isEmpty else { return [] }
        let faces = manual.installedSystems(on: date).flatMap(\.faces)
        return angleFlags(faces, detected: detected)
            + directionFlags(faces, detected: detected)
            + capacityFlags(manual.nameplateKw(on: date), detected: detected)
    }

    // MARK: - Angles

    private static func angleFlags(_ faces: [ManualSolarFace], detected: DetectedSolarLayout) -> [ManualLayoutFlag] {
        faces.flatMap { face -> [ManualLayoutFlag] in
            guard let plane = matchingPlane(for: face, in: detected.planes) else { return [] }
            var flags: [ManualLayoutFlag] = []
            if let entered = face.azimuthDegrees, plane.azimuthRange90.count == 2,
               azimuthOverrun(entered, plane: plane) > angleAllowance {
                flags.append(.azimuthOutsideDetectedRange(face: face.id, entered: entered, detected: plane.azimuth))
            }
            if let entered = face.tiltDegrees, plane.tiltRange90.count == 2,
               overrun(entered, low: plane.tiltRange90[0], high: plane.tiltRange90[1]) > angleAllowance {
                flags.append(.tiltOutsideDetectedRange(face: face.id, entered: entered, detected: plane.tilt))
            }
            return flags
        }
    }

    /// The plane the face most likely is: nearest in direction, or the largest when none was entered.
    private static func matchingPlane(
        for face: ManualSolarFace, in planes: [DetectedSolarLayout.Plane]
    ) -> DetectedSolarLayout.Plane? {
        guard let azimuth = face.azimuthDegrees else { return planes.max { $0.dcKwp < $1.dcKwp } }
        return planes.min { abs(signedDelta($0.azimuth, azimuth)) < abs(signedDelta($1.azimuth, azimuth)) }
    }

    /// Degrees outside the plane's range, measured around its azimuth so a range across north works.
    private static func azimuthOverrun(_ entered: Double, plane: DetectedSolarLayout.Plane) -> Double {
        overrun(
            signedDelta(plane.azimuth, entered),
            low: signedDelta(plane.azimuth, plane.azimuthRange90[0]),
            high: signedDelta(plane.azimuth, plane.azimuthRange90[1]))
    }

    private static func overrun(_ value: Double, low: Double, high: Double) -> Double {
        if value < low { return low - value }
        if value > high { return value - high }
        return 0
    }

    /// `target` minus `origin`, wrapped into (-180, 180].
    private static func signedDelta(_ origin: Double, _ target: Double) -> Double {
        var delta = (target - origin).truncatingRemainder(dividingBy: 360)
        if delta > 180 { delta -= 360 }
        if delta <= -180 { delta += 360 }
        return delta
    }

    // MARK: - Directions and capacity

    private static func directionFlags(
        _ faces: [ManualSolarFace], detected: DetectedSolarLayout
    ) -> [ManualLayoutFlag] {
        let entered = distinctDirections(faces.compactMap(\.azimuthDegrees))
        guard entered > 0, entered != detected.planes.count else { return [] }
        return [.directionCountDiffers(entered: entered, detected: detected.planes.count)]
    }

    /// Circular clustering: each gap wider than the spread between neighbours around the compass
    /// starts a new direction.
    static func distinctDirections(_ azimuths: [Double]) -> Int {
        let sorted = azimuths
            .map { ($0.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }
            .sorted()
        guard let first = sorted.first, let last = sorted.last else { return 0 }
        var gaps = zip(sorted, sorted.dropFirst()).map { $1 - $0 }
        gaps.append(first + 360 - last)
        return max(1, gaps.filter { $0 > sameDirectionSpread }.count)
    }

    private static func capacityFlags(_ nameplateKw: Double, detected: DetectedSolarLayout) -> [ManualLayoutFlag] {
        let fitted = detected.planes.reduce(0) { $0 + $1.effectiveKw }
        guard nameplateKw > 0, !healthyBand.contains(fitted / nameplateKw) else { return [] }
        return [.capacityOutsideBand(fittedKw: fitted, nameplateKw: nameplateKw)]
    }
}
