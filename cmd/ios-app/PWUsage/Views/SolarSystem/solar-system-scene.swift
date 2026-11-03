import SwiftUI

/// What the visual draws: the stored days with their types, the wedge, and the panel groups once
/// a layout is found.
struct SolarSystemSceneInput: Equatable {
    var days: [SiteHistoryStatus.Day] = []
    var clearDays = 0
    var fittedRange: [Double]?
    var latitude: Double?
    var groups: [SolarSystemHouse.Group] = []
    var isWaiting = false

    init(status: SiteHistoryStatus?, layout: SolarLayout?, isWaiting: Bool) {
        days = status?.days ?? []
        clearDays = status?.clearDays ?? 0
        if case .fitted(let range)? = status?.wedge { fittedRange = range }
        latitude = status?.latitude
        let planes = (status?.layout ?? layout)?.planes ?? []
        groups = planes.map { SolarSystemHouse.Group(azimuth: $0.azimuth, tilt: $0.tilt, kilowatts: $0.dcKwp) }
        if fittedRange == nil, let largest = planes.max(by: { $0.dcKwp < $1.dcKwp }) {
            fittedRange = [largest.azimuth, largest.azimuth]
        }
        self.isWaiting = isWaiting
    }

    var isFound: Bool { !groups.isEmpty }
}

/// The compass, the house and the calendar strip, with clear days flying between them. One clock
/// drives every layer; it stops when nothing moves (and always under Reduce Motion).
struct SolarSystemVisual: View {
    let input: SolarSystemSceneInput
    let summary: String

    static let sceneHeight: CGFloat = 250
    static let stripInset: CGFloat = 16

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0
    @State private var clocks = SolarSystemSceneClocks()
    @State private var camera = SolarSystemCamera(yaw: 180, elevation: 30)
    @State private var dragStart: SolarSystemCamera?

    private var strip: SolarSystemStripLayout {
        SolarSystemStripLayout(days: input.days.map(\.day), width: max(width - 2 * Self.stripInset, 0))
    }

    var body: some View {
        let strip = strip
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isMoving)) { context in
            let now = context.date
            let motion = reduceMotion ? SolarSystemSceneClocks() : clocks
            VStack(spacing: 0) {
                SolarSystemSceneCanvas(
                    input: input, clocks: motion, camera: swayed(camera, at: now), now: now)
                    .frame(height: Self.sceneHeight)
                    .contentShape(Rectangle())
                    .gesture(drag)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(summary)
                    .accessibilityAddTraits(.isImage)
                SolarSystemDayStrip(layout: strip, days: input.days, clocks: motion, now: now)
                    .padding(.horizontal, Self.stripInset)
                    .offset(y: input.isFound ? -12 * motion.found(at: now) : 0)
            }
            .overlay(alignment: .topLeading) {
                SolarSystemFlightCanvas(input: input, strip: strip, clocks: motion, now: now)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity)
        // A fixed-size picture: its labels stop growing, and VoiceOver reads the summary instead.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onAppear { observe() }
        .onChange(of: input) { observe() }
    }

    private var isMoving: Bool {
        guard !reduceMotion else { return false }
        return input.isFound || clocks.isAnimating(at: .now) || dragStart != nil
    }

    private func observe() {
        clocks.observe(days: input.days, hasLayout: input.isFound, now: .now)
    }

    /// A gentle sway while the found house is idle.
    private func swayed(_ camera: SolarSystemCamera, at now: Date) -> SolarSystemCamera {
        guard input.isFound, !reduceMotion, dragStart == nil else { return camera }
        var swayed = camera
        swayed.yaw += sin(now.timeIntervalSinceReferenceDate * 0.6) * 5
        return swayed
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard input.isFound else { return }
                let start = dragStart ?? camera
                dragStart = start
                camera = start.dragged(
                    yawBy: -Double(value.translation.width) * 0.4,
                    elevationBy: Double(value.translation.height) * 0.25)
            }
            .onEnded { _ in dragStart = nil }
    }
}

/// The compass seen from above while loading; on a find, the camera tilts down and the house
/// builds on it.
struct SolarSystemSceneCanvas: View {
    let input: SolarSystemSceneInput
    let clocks: SolarSystemSceneClocks
    let camera: SolarSystemCamera
    let now: Date

    var body: some View {
        Canvas { context, size in
            let found = input.isFound ? clocks.found(at: now) : 0
            let tilt = input.isFound ? Self.ease(Self.phase(found, from: 0, to: 0.35)) : 0
            let view = SolarSystemCamera(
                yaw: input.isFound ? camera.yaw : 180,
                elevation: 90 - (90 - camera.elevation) * tilt)
            let radius = min(size.width * 0.3, size.height * 0.38)
            let center = CGPoint(x: size.width / 2, y: size.height * (input.isFound ? 0.58 : 0.5))
            let ground = SceneProjection(camera: view, center: center, radius: radius)
            drawCompass(context, ground, found: tilt)
            if input.isFound {
                drawHouse(context, ground, progress: found)
            }
        }
    }

    // MARK: - Compass

    private func drawCompass(_ context: GraphicsContext, _ ground: SceneProjection, found: Double) {
        var context = context
        context.opacity = input.isWaiting ? 0.45 : 1
        var ring = Path()
        ring.addLines((0 ... 72).map { ground.point(azimuth: Double($0) * 5, distance: 1) })
        context.stroke(ring, with: .color(SolarSystemColors.ring), lineWidth: 2)

        for (azimuth, letter) in [(0.0, "N"), (90, "E"), (180, "S"), (270, "W")] {
            let text = Text(letter).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            context.draw(text, at: ground.point(azimuth: azimuth, distance: 1.16))
        }

        let center = SolarSystemWedge.center(fittedRange: input.fittedRange, latitude: input.latitude)
        let open = SolarSystemWedge.width(clearDays: input.clearDays, fittedRange: input.fittedRange)
        let width = open + (SolarSystemWedge.minimumWidth - open) * found
        var wedge = Path()
        wedge.move(to: ground.point(azimuth: 0, distance: 0))
        for step in 0 ... 24 {
            let azimuth = center - width / 2 + width * Double(step) / 24
            wedge.addLine(to: ground.point(azimuth: azimuth, distance: 0.94))
        }
        wedge.closeSubpath()
        context.fill(wedge, with: .color(SolarSystemColors.wedge.opacity(0.25)))

        for day in input.days.suffix(80) where day.type == .clear {
            let flight = clocks.flight(day.day, at: now)
            guard flight.travel >= 1 else { continue }
            let azimuth = center + Self.jitter(day.day) * width * 0.9
            let inner = 1 - 0.38 * flight.ray
            var ray = Path()
            ray.move(to: ground.point(azimuth: azimuth, distance: 1))
            ray.addLine(to: ground.point(azimuth: azimuth, distance: inner))
            context.stroke(ray, with: .color(SolarSystemColors.clear.opacity(0.65)), lineWidth: 1.5)
        }
    }

    // MARK: - House

    private func drawHouse(_ context: GraphicsContext, _ ground: SceneProjection, progress: Double) {
        let house = SolarSystemHouse(groups: input.groups)
        let scale = 0.82 / (max(house.length, house.depth) / 2)
        let rise = Self.ease(Self.phase(progress, from: 0.25, to: 0.5))
        let pitch = Self.ease(Self.phase(progress, from: 0.45, to: 0.65))
        guard rise > 0 else { return }
        func place(_ point: SIMD3<Double>) -> CGPoint {
            let roofLift = max(point.z - house.wallHeight, 0) * pitch
            let height = (min(point.z, house.wallHeight) + roofLift) * rise
            return ground.project([point.x * scale, point.y * scale, height * scale])
        }
        let light = SIMD3<Double>(0.4, -0.5, 0.77)
        for face in house.walls + house.roof where ground.camera.sees(face.normal) {
            var path = Path()
            path.addLines(face.corners.map(place))
            path.closeSubpath()
            let isRoof = face.normal.z > 0.01
            let base = isRoof ? Color(.systemGray) : Color(.systemGray5)
            context.fill(path, with: .color(base))
            let shade = 1 - max((face.normal * light).sum(), 0)
            context.fill(path, with: .color(.black.opacity(shade * 0.35)))
            context.stroke(path, with: .color(.black.opacity(0.18)), lineWidth: 0.5)
        }
        for (index, face) in house.roof.enumerated() where ground.camera.sees(face.normal) {
            let start = 0.65 + Double(index) * 0.08
            let drop = Self.ease(Self.phase(progress, from: start, to: start + 0.15))
            guard drop > 0 else { continue }
            for panel in face.panels {
                var path = Path()
                path.addLines(panel.map(place))
                path.closeSubpath()
                context.fill(path, with: .color(SolarSystemColors.panel.opacity(drop)))
                context.stroke(path, with: .color(.white.opacity(0.35 * drop)), lineWidth: 0.4)
            }
        }
    }

    // MARK: - Helpers

    static func phase(_ value: Double, from start: Double, to end: Double) -> Double {
        min(max((value - start) / (end - start), 0), 1)
    }

    static func ease(_ value: Double) -> Double { value * value * (3 - 2 * value) }

    /// A stable spread within the wedge, -0.5...0.5, from the day.
    static func jitter(_ day: String) -> Double {
        let hash = day.unicodeScalars.reduce(UInt32(2_166_136_261)) { ($0 ^ $1.value) &* 16_777_619 }
        return Double(hash % 1000) / 1000 - 0.5
    }
}

/// Ground and house points to the canvas: the compass rim is one unit.
struct SceneProjection {
    let camera: SolarSystemCamera
    let center: CGPoint
    let radius: CGFloat

    func project(_ point: SIMD3<Double>) -> CGPoint {
        let flat = camera.project(point)
        return CGPoint(x: center.x + flat.x * radius, y: center.y - flat.y * radius)
    }

    func point(azimuth: Double, distance: Double) -> CGPoint {
        let radians = azimuth * .pi / 180
        return project([sin(radians) * distance, cos(radians) * distance, 0])
    }
}

/// Newly clear days flying from their strip cell to the compass rim.
struct SolarSystemFlightCanvas: View {
    let input: SolarSystemSceneInput
    let strip: SolarSystemStripLayout
    let clocks: SolarSystemSceneClocks
    let now: Date

    var body: some View {
        Canvas { context, size in
            let radius = min(size.width * 0.3, SolarSystemVisual.sceneHeight * 0.38)
            let center = CGPoint(x: size.width / 2, y: SolarSystemVisual.sceneHeight * 0.5)
            let ground = SceneProjection(camera: SolarSystemCamera(yaw: 180, elevation: 90), center: center,
                                         radius: radius)
            let wedgeCenter = SolarSystemWedge.center(fittedRange: input.fittedRange, latitude: input.latitude)
            let width = SolarSystemWedge.width(clearDays: input.clearDays, fittedRange: input.fittedRange)
            for cell in strip.cells {
                let flight = clocks.flight(cell.day, at: now)
                guard flight.travel > 0, flight.travel < 1 else { continue }
                let frame = strip.frame(cell)
                let start = CGPoint(
                    x: frame.midX + SolarSystemVisual.stripInset, y: frame.midY + SolarSystemVisual.sceneHeight)
                let azimuth = wedgeCenter + SolarSystemSceneCanvas.jitter(cell.day) * width * 0.9
                let end = ground.point(azimuth: azimuth, distance: 1)
                let control = CGPoint(x: (start.x + end.x) / 2, y: min(start.y, end.y) - 40)
                let point = Self.bezier(start, control, end, SolarSystemSceneCanvas.ease(flight.travel))
                let dot = Path(ellipseIn: CGRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7))
                context.fill(dot, with: .color(SolarSystemColors.clear))
            }
        }
        .frame(height: SolarSystemVisual.sceneHeight + strip.height)
    }

    static func bezier(_ start: CGPoint, _ control: CGPoint, _ end: CGPoint, _ time: Double) -> CGPoint {
        let inverse = 1 - time
        return CGPoint(
            x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
            y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y)
    }
}
