import SwiftUI

/// The stand-in house as it builds (the reveal prototype's timing): walls rise over 1 s, the roof
/// pitches to the main group's tilt from 0.9 s to 1.9 s, then panels drop in face by face from
/// 2.1 s, each face 0.5 s after the last and over 1.6 s, falling 1.1 m into place.
struct SolarSystemHouseDrawing {
    let groups: [SolarSystemHouse.Group]
    /// Seconds into the build; anything past its end draws the finished house.
    let time: Double
    /// Optional health overlay for shading, soiling tint and multi-year aging.
    var health: SolarHouseHealthOverlay?

    func draw(_ context: GraphicsContext, _ ground: SceneProjection) {
        guard time >= 0 else { return }
        let ease = SolarSystemSceneClocks.ease
        let house = SolarSystemHouse(groups: groups)
        let walls = ease(time)
        let pitch = ease(time - 0.9)

        let footprint = house.walls.map { $0.corners[0] }
        context.fill(polygon(footprint.map { ground.project($0) }), with: .color(SolarSystemColors.shadow))

        func place(_ point: SIMD3<Double>, drop: Double = 0) -> CGPoint {
            let wall = min(point.z, house.wallHeight) * walls
            let roof = max(point.z - house.wallHeight, 0) * pitch
            return ground.project([point.x, point.y, wall + roof + drop])
        }
        let sun = health?.sunVector ?? SolarSystemColors.sun
        for face in house.walls where ground.camera.sees(face.normal) {
            context.fill(polygon(face.corners.map { place($0) }),
                         with: .color(SolarSystemColors.shaded(SolarSystemColors.wall, normal: face.normal, sun: sun)))
        }
        guard walls >= 0.98 else { return }
        var order = 0.0
        let panelBase = SolarSystemColors.panel(dirtAmount: health?.dirtAmount ?? 0)
        for face in house.roof where ground.camera.sees(face.normal) {
            let faceShaded = (health?.isSunShaded ?? false) && (health?.sunElevation ?? 0) > 0
            context.fill(
                polygon(face.corners.map { place($0) }),
                with: .color(SolarSystemColors.shaded(
                    SolarSystemColors.roof, normal: face.normal, sun: sun, isShaded: faceShaded)))
            guard pitch >= 0.98, !face.panels.isEmpty else { continue }
            let appear = min(max((time - 2.1 - order * 0.5) / 1.6, 0), 1) * Double(face.panels.count)
            order += 1
            let opacity = health?.panelOpacity(forAzimuth: face.azimuth) ?? 1.0
            let color = SolarSystemColors.shaded(
                panelBase, normal: face.normal, sun: sun, isShaded: faceShaded).opacity(opacity)
            for (index, panel) in face.panels.enumerated() where Double(index) < appear {
                let drop = max(0, 1 - (appear - Double(index))) * 1.1
                let shape = polygon(panel.map { place($0, drop: drop) })
                context.fill(shape, with: .color(color))
                context.stroke(shape, with: .color(SolarSystemColors.panelEdge), lineWidth: 0.6)
            }
        }
    }

    private func polygon(_ points: [CGPoint]) -> Path {
        var path = Path()
        path.addLines(points)
        path.closeSubpath()
        return path
    }
}
