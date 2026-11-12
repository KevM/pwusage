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
    /// Found while nobody was watching: replay the find the first time it can be seen.
    var isRevealOwed = false

    /// `manualLayout`: the faces the owner entered, which replace the found groups on the house.
    init(
        status: SiteHistoryStatus?, layout: SolarLayout?, isWaiting: Bool,
        manualLayout: ManualSolarLayout? = nil, now: Date = .now
    ) {
        days = status?.days ?? []
        clearDays = status?.clearDays ?? 0
        if case .fitted(let range)? = status?.wedge { fittedRange = range }
        latitude = status?.latitude
        let found = status?.layout ?? layout
        if let manualLayout {
            groups = manualLayout.houseGroups(detected: found, on: now)
            // The compass follows the entered main face, not the fit it replaces.
            fittedRange = groups.max { $0.kilowatts < $1.kilowatts }.map { [$0.azimuth, $0.azimuth] }
        } else {
            let planes = found?.planes ?? []
            groups = planes.map { SolarSystemHouse.Group(azimuth: $0.azimuth, tilt: $0.tilt, kilowatts: $0.dcKwp) }
            if fittedRange == nil, let largest = planes.max(by: { $0.dcKwp < $1.dcKwp }) {
                fittedRange = [largest.azimuth, largest.azimuth]
            }
        }
        self.isWaiting = isWaiting
        isRevealOwed = status?.isRevealOwed ?? false
    }

    var isFound: Bool { !groups.isEmpty }
}

/// The compass, the house and, until the house stands, the calendar strip, with clear days flying
/// between them, on the reveal prototype's timeline. One clock drives every layer; it stops when nothing moves (and
/// always under Reduce Motion, where every state shows in place).
struct SolarSystemVisual: View {
    let input: SolarSystemSceneInput
    let summary: String
    var onRevealSeen: () -> Void = {}

    nonisolated static let sceneHeight: CGFloat = 300
    /// Once the house stands: about a quarter of its height in gutter above and below.
    nonisolated static let foundSceneHeight: CGFloat = 196
    nonisolated static let stripInset: CGFloat = 16

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// On screen in the visible tab; a tab keeps its screen alive while another shows.
    @State private var isOnScreen = false
    @State private var width: CGFloat = 0
    @State private var clocks = SolarSystemSceneClocks()
    @State private var camera = SolarSystemCamera.found
    @State private var dragStart: SolarSystemCamera?

    private var strip: SolarSystemStripLayout {
        SolarSystemStripLayout(days: input.days.map(\.day), width: max(width - 2 * Self.stripInset, 0))
    }

    var body: some View {
        let settled = strip
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !isMoving)) { context in
            let now = context.date
            let motion = reduceMotion ? SolarSystemSceneClocks() : clocks
            let frame = SceneFrame(input: input, clocks: motion, camera: swayed(camera, at: now), now: now)
            let strip = settled.widening(to: motion.widenedColumns(at: now))
            VStack(spacing: 0) {
                SolarSystemSceneCanvas(input: input, clocks: motion, frame: frame, now: now)
                    .frame(height: frame.sceneHeight)
                    .overlay {
                        // Only the square around the model turns it, so the gutters still scroll.
                        Color.clear
                            .frame(width: min(width, Self.sceneHeight), height: frame.sceneHeight)
                            .contentShape(Rectangle())
                            .gesture(drag(sceneHeight: frame.sceneHeight))
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(summary)
                    .accessibilityAddTraits(.isImage)
                if frame.stripPresence > 0 {
                    SolarSystemDayStrip(layout: strip, days: input.days, clocks: motion, now: now)
                        .padding(.horizontal, Self.stripInset)
                        .opacity(frame.stripPresence)
                        .frame(height: strip.height * frame.stripPresence, alignment: .top)
                        .clipped()
                }
            }
            .overlay(alignment: .topLeading) {
                if frame.stripPresence > 0 {
                    SolarSystemFlightCanvas(input: input, strip: strip, clocks: motion, frame: frame, now: now)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .overlay { if motion.isReplaying, motion.isAnimating(at: now) { skipArea } }
        }
        .frame(maxWidth: .infinity)
        .opacity(isHoldingForReveal ? 0 : 1)
        // A fixed-size picture: its labels stop growing, and VoiceOver reads the summary instead.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onAppear { isOnScreen = true }
        .onDisappear { isOnScreen = false }
        // What happened out of sight stays out of sight, so coming back starts a fresh first look,
        // which replays only an owed reveal.
        .onChange(of: isWatching, initial: true) {
            clocks = SolarSystemSceneClocks()
            observe()
        }
        .onChange(of: input) { observe() }
        .onChange(of: width) { observe() }
        .task(id: RevealWatch(isOwed: input.isRevealOwed, isWatching: isWatching, reveal: clocks.reveal)) {
            await acknowledgeReveal()
        }
    }

    private var isWatching: Bool { isOnScreen && scenePhase == .active }

    /// A reveal hasn't started yet (it needs the width), and the finished house mustn't show first.
    private var isHoldingForReveal: Bool {
        input.isRevealOwed && !reduceMotion && !clocks.hasObserved
    }

    private var skipArea: some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture { clocks.skipReveal() }
            .accessibilityHidden(true)
    }

    private struct RevealWatch: Equatable {
        let isOwed: Bool
        let isWatching: Bool
        let reveal: SolarSystemSceneClocks.Reveal
    }

    /// Seen once the house starts to rise, or at once when skipped or under Reduce Motion, where it
    /// simply stands there. Leaving first cancels this, so the banner comes back.
    private func acknowledgeReveal() async {
        guard input.isRevealOwed, isWatching else { return }
        if !reduceMotion {
            switch clocks.reveal {
            case .none:
                return
            case .skipped:
                break
            case .playing(let seenAt):
                try? await Task.sleep(for: .seconds(max(seenAt.timeIntervalSinceNow, 0)))
                guard !Task.isCancelled else { return }
            }
        }
        onRevealSeen()
    }

    private var isMoving: Bool {
        guard !reduceMotion, isWatching else { return false }
        return input.isFound || clocks.isAnimating(at: .now) || dragStart != nil
    }

    private func observe() {
        guard isWatching else { return }
        let revealOwed = input.isRevealOwed && !reduceMotion
        if revealOwed, width == 0 { return }
        clocks.observe(days: input.days, columns: strip.columns, hasLayout: input.isFound, revealOwed: revealOwed,
                       now: .now)
    }

    /// A gentle sway once the house stands.
    private func swayed(_ camera: SolarSystemCamera, at now: Date) -> SolarSystemCamera {
        guard input.isFound, !reduceMotion, dragStart == nil else { return camera }
        var swayed = camera
        swayed.yaw += sin(now.timeIntervalSinceReferenceDate * 0.6) * 4
        return swayed
    }

    private func drag(sceneHeight: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard input.isFound else { return }
                let start = dragStart ?? camera
                dragStart = start
                // Like a turntable: the half under the finger follows it, so the near side turns the
                // other way from the far side.
                let side: Double = value.startLocation.y > sceneHeight / 2 ? 1 : -1
                camera = start.dragged(
                    yawBy: side * Double(value.translation.width) * 0.4,
                    elevationBy: Double(value.translation.height) * 0.25)
            }
            .onEnded { _ in dragStart = nil }
    }
}

/// One moment of the scene, shared by its layers: the camera, the wedge and the strip's presence.
struct SceneFrame {
    /// The compass ring's radius in world units; the house is in meters on the same scale.
    static let ringRadius = 9.0
    static let rim = 8.2
    static let letterRadius = 10.1

    let camera: SolarSystemCamera
    /// 0...1 through the tilt; 0 while still loading.
    let build: Double
    let wedgeCenter: Double
    let wedgeWidth: Double
    /// The wedge and rays fade out as the house replaces them.
    let wedgeOpacity: Double
    let landedClear: Int
    /// 1 while loading; falls to 0 through the tilt, as a found system has no use for the strip.
    let stripPresence: Double
    /// Tightens with the strip leaving, from the loading height to the found one.
    let sceneHeight: CGFloat

    init(
        input: SolarSystemSceneInput, clocks: SolarSystemSceneClocks, camera target: SolarSystemCamera, now: Date
    ) {
        let ease = SolarSystemSceneClocks.ease
        build = input.isFound ? clocks.build(at: now) : 0
        camera = input.isFound ? .tilting(to: target, progress: ease(build)) : .overhead
        landedClear = input.days.count { $0.type == .clear && clocks.hasLanded($0.day, at: now) }
        if input.isFound, let main = input.groups.max(by: { $0.kilowatts < $1.kilowatts }) {
            wedgeCenter = main.azimuth
        } else {
            wedgeCenter = SolarSystemWedge.center(fittedRange: input.fittedRange, latitude: input.latitude)
        }
        // A replay narrows the wedge as days land, as if the fit weren't known yet.
        let range = clocks.isReplaying ? nil : input.fittedRange
        var width = SolarSystemWedge.width(clearDays: max(landedClear, 1), fittedRange: range)
        if input.isFound {
            // On a find the wedge closes to one direction over 0.8 s.
            let closing = ease(min(build * SolarSystemSceneClocks.buildDuration / 0.8, 1))
            width = width * (1 - closing) + 1
        }
        wedgeWidth = width
        wedgeOpacity = 1 - min(max((build - 0.35) / 0.3, 0), 1)
        stripPresence = input.isFound ? 1 - ease((build - 0.3) / 0.7) : 1
        sceneHeight = SolarSystemVisual.foundSceneHeight
            + (SolarSystemVisual.sceneHeight - SolarSystemVisual.foundSceneHeight) * stripPresence
    }

    /// The canvas point for a world point, with the compass centered in the scene. Steep drag angles
    /// stand the ring up, so the model scales down just enough to keep its letters inside.
    func projection(width: CGFloat) -> SceneProjection {
        // The letters sit outside the ring; keep them well clear of the strip below.
        let radius = min(width * 0.3, SolarSystemVisual.sceneHeight * 0.36)
        let letterMargin: CGFloat = 8
        let rise = Self.letterRadius * sin(camera.elevation * .pi / 180)
        let fitted = (sceneHeight / 2 - letterMargin) / rise
        return SceneProjection(
            camera: camera, center: CGPoint(x: width / 2, y: sceneHeight / 2),
            scale: min(radius / Self.ringRadius, fitted))
    }

    /// Where a clear day's ray sits within the wedge.
    func rayAzimuth(_ day: String) -> Double {
        wedgeCenter + (SolarSystemSceneClocks.spread(day) - 0.5) * wedgeWidth * 0.9
    }
}

/// The compass seen from above while loading; on a find, the camera tilts down and the house
/// builds on it.
struct SolarSystemSceneCanvas: View {
    let input: SolarSystemSceneInput
    let clocks: SolarSystemSceneClocks
    let frame: SceneFrame
    let now: Date

    var body: some View {
        Canvas { context, size in
            let ground = frame.projection(width: size.width)
            drawCompass(context, ground)
            if input.isFound, clocks.houseTime(at: now) >= 0 {
                SolarSystemHouseDrawing(groups: input.groups, time: clocks.houseTime(at: now))
                    .draw(context, ground)
            }
        }
    }

    private func drawCompass(_ context: GraphicsContext, _ ground: SceneProjection) {
        var context = context
        context.opacity = input.isWaiting ? 0.45 : 1
        var ring = Path()
        ring.addLines((0 ... 72).map { ground.point(azimuth: Double($0) * 5, distance: SceneFrame.ringRadius) })
        ring.closeSubpath()
        context.fill(ring, with: .color(SolarSystemColors.disk))
        context.stroke(ring, with: .color(SolarSystemColors.ring), lineWidth: 1)
        for (azimuth, letter) in [(0.0, "N"), (90, "E"), (180, "S"), (270, "W")] {
            let text = Text(letter).font(.system(size: 12)).foregroundStyle(.secondary)
            context.draw(text, at: ground.point(azimuth: azimuth, distance: SceneFrame.letterRadius))
        }
        guard frame.wedgeOpacity > 0, frame.landedClear > 0 else { return }
        var wedge = Path()
        wedge.move(to: ground.point(azimuth: 0, distance: 0))
        for step in 0 ... 24 {
            let azimuth = frame.wedgeCenter - frame.wedgeWidth / 2 + frame.wedgeWidth * Double(step) / 24
            wedge.addLine(to: ground.point(azimuth: azimuth, distance: SceneFrame.rim))
        }
        wedge.closeSubpath()
        let fill = 0.42 * frame.wedgeOpacity * min(Double(frame.landedClear) / 3, 1)
        context.fill(wedge, with: .color(SolarSystemColors.wedge.opacity(fill)))
        let center = ground.point(azimuth: 0, distance: 0)
        for day in input.days.suffix(240) where day.type == .clear && clocks.hasLanded(day.day, at: now) {
            var ray = Path()
            ray.move(to: center)
            ray.addLine(to: ground.point(azimuth: frame.rayAzimuth(day.day), distance: SceneFrame.rim))
            context.stroke(ray, with: .color(SolarSystemColors.ray.opacity(0.5 * frame.wedgeOpacity)), lineWidth: 1)
        }
    }
}

/// World points to the canvas.
struct SceneProjection {
    let camera: SolarSystemCamera
    let center: CGPoint
    /// Points per world unit.
    let scale: CGFloat

    func project(_ point: SIMD3<Double>) -> CGPoint {
        let flat = camera.project(point)
        return CGPoint(x: center.x + flat.x * scale, y: center.y - flat.y * scale)
    }

    func point(azimuth: Double, distance: Double, height: Double = 0.02) -> CGPoint {
        let radians = azimuth * .pi / 180
        return project([sin(radians) * distance, cos(radians) * distance, height])
    }
}

/// Newly clear days flying from their strip dot to the rim, then melting into a ray toward the
/// center over the flight's last 38%.
struct SolarSystemFlightCanvas: View {
    let input: SolarSystemSceneInput
    let strip: SolarSystemStripLayout
    let clocks: SolarSystemSceneClocks
    let frame: SceneFrame
    let now: Date

    var body: some View {
        Canvas { context, size in
            let ground = frame.projection(width: size.width)
            let center = ground.point(azimuth: 0, distance: 0, height: 0.03)
            let melt = SolarSystemSceneClocks.melt
            for cell in strip.cells {
                let progress = clocks.flight(cell.day, at: now)
                guard progress > 0, progress < 1 else { continue }
                let rim = ground.point(azimuth: frame.rayAzimuth(cell.day), distance: SceneFrame.rim, height: 0.03)
                if progress < 1 - melt {
                    let travel = progress / (1 - melt)
                    let dot = strip.frame(cell)
                    let start = CGPoint(x: dot.midX + SolarSystemVisual.stripInset,
                                        y: dot.midY + frame.sceneHeight)
                    let control = CGPoint(x: (start.x + rim.x) / 2 + (rim.x - center.x) * 0.4,
                                          y: min(start.y, rim.y) - 60)
                    let point = Self.bezier(start, control, rim, SolarSystemSceneClocks.ease(travel))
                    let radius = 3.6 + 1.4 * sin(travel * .pi)
                    context.fill(
                        Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius,
                                               width: 2 * radius, height: 2 * radius)),
                        with: .color(SolarSystemColors.clear))
                } else {
                    let melted = SolarSystemSceneClocks.ease((progress - (1 - melt)) / melt)
                    var ray = Path()
                    ray.move(to: rim)
                    ray.addLine(to: CGPoint(x: rim.x + (center.x - rim.x) * melted,
                                            y: rim.y + (center.y - rim.y) * melted))
                    context.stroke(ray, with: .color(SolarSystemColors.clear.opacity(1 - 0.5 * melted)),
                                   style: StrokeStyle(lineWidth: 3.6 - 2.6 * melted, lineCap: .round))
                }
            }
        }
        .frame(height: frame.sceneHeight + strip.height)
    }

    static func bezier(_ start: CGPoint, _ control: CGPoint, _ end: CGPoint, _ time: Double) -> CGPoint {
        let inverse = 1 - time
        return CGPoint(
            x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
            y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y)
    }
}
