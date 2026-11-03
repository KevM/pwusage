import Foundation

/// The compass wedge: where the panels may face. Before a fit its width only reflects how many
/// clear days are in (the prototypes' curves); after one it is the largest plane's 90% azimuth range.
enum SolarSystemWedge {
    static let minimumWidth = 4.0

    /// Width in degrees.
    static func width(clearDays: Int, fittedRange: [Double]?) -> Double {
        if let fittedRange, fittedRange.count == 2 {
            return min(max(SolarLayoutDetector.rangeWidth(fittedRange), minimumWidth), 360)
        }
        return 4 + 160 * pow(8 / (Double(max(clearDays, 0)) + 8), 1.25)
    }

    /// The banner's smaller compass narrows on its own, steeper curve.
    static func bannerWidth(clearDays: Int, fittedRange: [Double]?) -> Double {
        if fittedRange != nil { return width(clearDays: clearDays, fittedRange: fittedRange) }
        return 6 + 150 * pow(6 / (Double(max(clearDays, 0)) + 6), 1.3)
    }

    /// Center azimuth in degrees: the fitted range's middle, or the equator-facing direction.
    static func center(fittedRange: [Double]?, latitude: Double?) -> Double {
        if let fittedRange, fittedRange.count == 2 {
            let middle = fittedRange[0] + SolarLayoutDetector.rangeWidth(fittedRange) / 2
            return middle.truncatingRemainder(dividingBy: 360)
        }
        return (latitude ?? 1) < 0 ? 0 : 180
    }
}

/// A neutral stand-in house: a hip roof over a box, sized by the system's kW. The largest panel
/// group takes the front face; every other group takes the face nearest its direction.
struct SolarSystemHouse: Equatable {
    struct Group: Equatable {
        let azimuth: Double
        let tilt: Double
        let kilowatts: Double
    }

    struct Face: Equatable {
        let side: SolarSystemRoofSide
        /// Compass direction the face looks toward, degrees.
        let azimuth: Double
        /// Corners in world space (x east, y north, z up), eave first.
        let corners: [SIMD3<Double>]
        let normal: SIMD3<Double>
        /// Panel quads in world space.
        var panels: [[SIMD3<Double>]] = []
    }

    static let panelKw = 0.4
    static let panelSize = (width: 1.02, length: 1.7)
    /// The roof's overhang past the walls, meters.
    static let overhang = 0.3

    let length: Double
    let depth: Double
    let wallHeight: Double
    let pitchDegrees: Double
    let frontAzimuth: Double
    let roof: [Face]
    let walls: [Face]

    init(groups: [Group]) {
        let totalKw = groups.reduce(0) { $0 + max($1.kilowatts, 0) }
        let largest = groups.max { $0.kilowatts < $1.kilowatts }
        // Scaled with the square root of the size: 9 kW is the 12 × 8 m reference house.
        let scale = min(max((totalKw / 9).squareRoot(), 0.72), 1.3)
        length = 12 * scale
        depth = 8 * scale
        wallHeight = 2.6 * scale
        pitchDegrees = min(max(largest?.tilt ?? 25, 8), 50)
        frontAzimuth = largest?.azimuth ?? 180
        let frame = HouseFrame(
            length: length, depth: depth, wallHeight: wallHeight, pitch: pitchDegrees, azimuth: frontAzimuth)
        var roof = frame.roofFaces()
        for (side, sideGroups) in Self.assign(groups, frontAzimuth: frontAzimuth) {
            let count = sideGroups.reduce(0) { $0 + Self.panelCount(kilowatts: $1.kilowatts) }
            roof[side.rawValue].panels = frame.panels(on: side, count: count)
        }
        self.roof = roof
        walls = frame.wallFaces()
    }

    static func panelCount(kilowatts: Double) -> Int {
        max(Int((kilowatts / panelKw).rounded()), kilowatts > 0 ? 1 : 0)
    }

    /// The face each group goes on: the largest takes the front, the rest the nearest side.
    static func assign(_ groups: [Group], frontAzimuth: Double) -> [SolarSystemRoofSide: [Group]] {
        guard let largestIndex = groups.indices.max(by: { groups[$0].kilowatts < groups[$1].kilowatts }) else {
            return [:]
        }
        var assigned: [SolarSystemRoofSide: [Group]] = [.front: [groups[largestIndex]]]
        for (index, group) in groups.enumerated() where index != largestIndex {
            let side = SolarSystemRoofSide.allCases.min { lhs, rhs in
                angleBetween(group.azimuth, faceAzimuth(lhs, front: frontAzimuth))
                    < angleBetween(group.azimuth, faceAzimuth(rhs, front: frontAzimuth))
            } ?? .front
            assigned[side, default: []].append(group)
        }
        return assigned
    }

    static func faceAzimuth(_ side: SolarSystemRoofSide, front: Double) -> Double {
        (front + Double(side.rawValue) * 90).truncatingRemainder(dividingBy: 360)
    }

    static func angleBetween(_ lhs: Double, _ rhs: Double) -> Double {
        let difference = abs(lhs - rhs).truncatingRemainder(dividingBy: 360)
        return min(difference, 360 - difference)
    }
}

/// A face's place on the house, clockwise from the front seen from above.
enum SolarSystemRoofSide: Int, CaseIterable { case front, right, back, left }

/// The house's local frame: `x` along the ridge, `y` toward the front, rotated to `azimuth`.
private struct HouseFrame {
    let length: Double
    let depth: Double
    let wallHeight: Double
    let pitch: Double
    let azimuth: Double

    /// Horizontal run from the eave (past the overhang) to the ridge; every face pitches at `pitch`.
    private var run: Double { depth / 2 + SolarSystemHouse.overhang }
    private var ridgeHeight: Double { run * tan(pitch * .pi / 180) }

    /// Local to world: the front (`+y`) looks toward the compass `azimuth`.
    private func world(_ along: Double, _ across: Double, _ height: Double) -> SIMD3<Double> {
        let radians = azimuth * .pi / 180
        let front = SIMD2(sin(radians), cos(radians))
        let right = SIMD2(cos(radians), -sin(radians))
        let flat = right * along + front * across
        return SIMD3(flat.x, flat.y, height)
    }

    /// Eave start, eave end and the top corner(s), local coordinates, per side.
    private func roofCorners(_ side: SolarSystemRoofSide) -> [SIMD3<Double>] {
        let ridge = (length - depth) / 2
        let (halfL, halfD) = (length / 2 + SolarSystemHouse.overhang, run)
        let (top, base) = (wallHeight + ridgeHeight, wallHeight)
        switch side {
        case .front: return [[-halfL, halfD, base], [halfL, halfD, base], [ridge, 0, top], [-ridge, 0, top]]
        case .right: return [[halfL, halfD, base], [halfL, -halfD, base], [ridge, 0, top]]
        case .back: return [[halfL, -halfD, base], [-halfL, -halfD, base], [-ridge, 0, top], [ridge, 0, top]]
        case .left: return [[-halfL, -halfD, base], [-halfL, halfD, base], [-ridge, 0, top]]
        }
    }

    private func toWorld(_ local: SIMD3<Double>) -> SIMD3<Double> { world(local.x, local.y, local.z) }

    func roofFaces() -> [SolarSystemHouse.Face] {
        SolarSystemRoofSide.allCases.map { side in
            let corners = roofCorners(side).map(toWorld)
            return SolarSystemHouse.Face(
                side: side, azimuth: SolarSystemHouse.faceAzimuth(side, front: azimuth), corners: corners,
                normal: Self.normal(corners))
        }
    }

    func wallFaces() -> [SolarSystemHouse.Face] {
        let (halfL, halfD, top) = (length / 2, depth / 2, wallHeight)
        let footprint: [SIMD3<Double>] = [
            [-halfL, halfD, 0], [halfL, halfD, 0], [halfL, -halfD, 0], [-halfL, -halfD, 0]]
        return SolarSystemRoofSide.allCases.map { side in
            let start = footprint[side.rawValue]
            let end = footprint[(side.rawValue + 1) % 4]
            let corners = [start, end, end + [0, 0, top], start + [0, 0, top]].map(toWorld)
            return SolarSystemHouse.Face(
                side: side, azimuth: SolarSystemHouse.faceAzimuth(side, front: azimuth), corners: corners,
                normal: Self.normal(corners))
        }
    }

    /// Outward normal of a counter-clockwise (seen from outside) polygon.
    private static func normal(_ corners: [SIMD3<Double>]) -> SIMD3<Double> {
        let first = corners[1] - corners[0]
        let second = corners[corners.count - 1] - corners[0]
        let raw = cross(second, first)
        let length = (raw * raw).sum().squareRoot()
        return length > 0 ? raw / length : raw
    }

    /// `count` panels in rows up the face, shrunk until they fit inside it.
    func panels(on side: SolarSystemRoofSide, count: Int) -> [[SIMD3<Double>]] {
        guard count > 0 else { return [] }
        let local = roofCorners(side)
        let eave = local[1] - local[0]
        let eaveLength = (eave * eave).sum().squareRoot()
        let eaveDirection = eave / eaveLength
        let slopeLength = run / cos(pitch * .pi / 180)
        let inward = cross(eaveDirection, [0, 0, 1])
        let slopeDirection = (inward * run + SIMD3(0, 0, ridgeHeight)) / slopeLength
        // Flattened, every face's top edge is inset by the run at each end.
        let shape = FaceShape(width: eaveLength, slope: slopeLength, inset: run)
        for scale in stride(from: 1.0, to: 0.05, by: -0.05) {
            let rects = shape.grid(panelWidth: SolarSystemHouse.panelSize.width * scale,
                                   panelLength: SolarSystemHouse.panelSize.length * scale, count: count)
            guard rects.count >= count else { continue }
            return rects.prefix(count).map { rect in
                [(rect.minX, rect.minY), (rect.maxX, rect.minY), (rect.maxX, rect.maxY), (rect.minX, rect.maxY)]
                    .map { along, upSlope in
                        toWorld(local[0] + eaveDirection * Double(along) + slopeDirection * Double(upSlope)
                            + [0, 0, 0.06])
                    }
            }
        }
        return []
    }
}

/// A roof face flattened: eave `0...width` at `v = 0`, top edge `inset...width - inset` at `v = slope`.
struct FaceShape {
    let width: Double
    let slope: Double
    let inset: Double
    var margin: Double { min(width, slope) * 0.06 }

    /// The usable `u` range at height `v`.
    func extent(at height: Double) -> ClosedRange<Double> {
        let side = inset * height / slope + margin
        return side ... max(width - side, side)
    }

    /// Rows of panels from the eave up, each row centered in the narrower of its two edges.
    func grid(panelWidth: Double, panelLength: Double, count: Int) -> [CGRect] {
        var rects: [CGRect] = []
        let gap = panelWidth * 0.08
        var bottom = margin
        while bottom + panelLength <= slope - margin, rects.count < count {
            let low = extent(at: bottom)
            let high = extent(at: bottom + panelLength)
            let start = max(low.lowerBound, high.lowerBound)
            let end = min(low.upperBound, high.upperBound)
            let fits = Int(((end - start) + gap) / (panelWidth + gap))
            let used = Double(fits) * (panelWidth + gap) - gap
            var left = start + (end - start - used) / 2
            for _ in 0 ..< max(fits, 0) where rects.count < count {
                rects.append(CGRect(x: left, y: bottom, width: panelWidth, height: panelLength))
                left += panelWidth + gap
            }
            bottom += panelLength + gap
        }
        return rects
    }
}

/// Orthographic camera: placed at compass `yaw` from the house, `elevation` degrees above the
/// horizon, looking at the origin. Screen `y` grows upward.
struct SolarSystemCamera: Equatable {
    var yaw: Double
    var elevation: Double

    static let elevationRange = 8.0 ... 75.0
    /// Looking straight down at the compass, north up.
    static let overhead = SolarSystemCamera(yaw: 180, elevation: 90)
    /// Where the tilt ends: 32° up, turned 26° (the reveal prototype's camera).
    static let found = SolarSystemCamera(yaw: 154, elevation: 32)

    /// Between the overhead view and `target` as the tilt runs (`progress` 0...1, eased by the caller).
    static func tilting(to target: SolarSystemCamera, progress: Double) -> SolarSystemCamera {
        SolarSystemCamera(
            yaw: overhead.yaw + (target.yaw - overhead.yaw) * progress,
            elevation: overhead.elevation + (target.elevation - overhead.elevation) * progress)
    }

    private var right: SIMD3<Double> {
        let radians = yaw * .pi / 180
        return [-cos(radians), sin(radians), 0]
    }

    /// From the camera toward the scene.
    var forward: SIMD3<Double> {
        let yawRadians = yaw * .pi / 180
        let elevationRadians = elevation * .pi / 180
        return [-sin(yawRadians) * cos(elevationRadians), -cos(yawRadians) * cos(elevationRadians),
                -sin(elevationRadians)]
    }

    private var upward: SIMD3<Double> { cross(right, forward) }

    func project(_ point: SIMD3<Double>) -> CGPoint {
        CGPoint(x: (point * right).sum(), y: (point * upward).sum())
    }

    /// Whether a face with outward `normal` faces the camera. The house is convex, so the
    /// visible faces never overlap and need no depth sorting.
    func sees(_ normal: SIMD3<Double>) -> Bool {
        (normal * forward).sum() < -1e-9
    }

    /// Dragging turns the house; elevation stays within its range.
    func dragged(yawBy yawDelta: Double, elevationBy elevationDelta: Double) -> SolarSystemCamera {
        SolarSystemCamera(
            yaw: (yaw + yawDelta).truncatingRemainder(dividingBy: 360),
            elevation: min(max(elevation + elevationDelta, Self.elevationRange.lowerBound),
                           Self.elevationRange.upperBound))
    }
}

private func cross(_ lhs: SIMD3<Double>, _ rhs: SIMD3<Double>) -> SIMD3<Double> {
    SIMD3(lhs.y * rhs.z - lhs.z * rhs.y, lhs.z * rhs.x - lhs.x * rhs.z, lhs.x * rhs.y - lhs.y * rhs.x)
}
