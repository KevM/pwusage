import SwiftUI

/// What the tab bar's banner shows: the story of the Solar System screen in miniature.
struct SolarSystemBannerModel: Equatable {
    enum Mode: Equatable { case loading, needsLocation, found }

    let title = "Found your solar system"
    let inlineTitle = "Solar system found"

    let mode: Mode
    let countText: String
    /// Every stored day with its pass type, oldest first; new ones glide in along the track.
    let days: [SiteHistoryStatus.Day]
    /// Waiting out a Tesla limit or a backoff: the dots stop and the compass dims.
    let isPaused: Bool
    let fittedRange: [Double]?
    let latitude: Double?
    let accessibilityLabel: String
    /// "8.8 kW · facing south-southwest" once found.
    let detailText: String
    /// The largest panel group's direction, once found.
    private let foundAzimuth: Double?

    init(presentation: SiteHistoryPresentation, status: SiteHistoryStatus?) {
        let found = status?.isRevealOwed == true ? status?.layout : nil
        mode = if found != nil {
            .found
        } else {
            presentation.phase == .needsLocation ? .needsLocation : .loading
        }
        countText = SiteHistoryPresentation.days(presentation.downloadedDays)
        days = status?.days ?? []
        isPaused = presentation.phase == .waiting
        if case .fitted(let range)? = status?.wedge { fittedRange = range } else { fittedRange = nil }
        latitude = status?.latitude
        foundAzimuth = found?.planes.max(by: { $0.dcKwp < $1.dcKwp })?.azimuth
        detailText = found.map(Self.detail) ?? ""
        accessibilityLabel = switch mode {
        case .needsLocation: "Add your location to find your solar system"
        case .loading: presentation.accessibilitySummary
        case .found: "Found your solar system. " + (found.map(SiteHistoryPresentation.describe) ?? "")
        }
    }

    private static func detail(_ layout: SolarLayout) -> String {
        let total = layout.planes.reduce(0) { $0 + $1.dcKwp }
        let size = "\(total.formatted(.number.precision(.fractionLength(1)))) kW"
        guard let main = layout.planes.max(by: { $0.dcKwp < $1.dcKwp }) else { return size }
        return "\(size) · facing \(SolarSystemCompass.name(main.azimuth))"
    }

    var wedgeCenter: Double {
        foundAzimuth ?? SolarSystemWedge.center(fittedRange: fittedRange, latitude: latitude)
    }
}

/// The banner prototype's motion: each newly downloaded day glides along the track from the right
/// over 0.9 s, in threes 1.1 s apart; at a pass the clear ones arc into the compass over 0.7 s.
/// The first observation records nothing, so the banner appearing replays nothing.
struct SolarSystemBannerClocks: Equatable {
    static let glideDuration = 0.9
    static let arcDuration = 0.7
    static let groupSpacing = 1.1
    static let stagger = 0.12

    private(set) var glides: [String: Date] = [:]
    private(set) var arcs: [String: Date] = [:]
    private var known: Set<String>?
    private var knownClear: Set<String> = []

    mutating func observe(days: [SiteHistoryStatus.Day], now: Date) {
        let ids = Set(days.map(\.day))
        let clear = Set(days.filter { $0.type == .clear }.map(\.day))
        if let known {
            for (index, day) in ids.subtracting(known).sorted(by: >).prefix(30).enumerated() {
                glides[day] = now.addingTimeInterval(
                    Double(index / 3) * Self.groupSpacing + Double(index % 3) * Self.stagger)
            }
            for (index, day) in clear.subtracting(knownClear).sorted().enumerated() {
                let arrived = glides[day].map { $0.addingTimeInterval(Self.glideDuration) } ?? now
                arcs[day] = max(arrived, now).addingTimeInterval(Double(min(index, 12)) * 0.05)
            }
        }
        known = ids
        knownClear = clear
        glides = glides.filter { now.timeIntervalSince($0.value) < 60 }
        arcs = arcs.filter { now.timeIntervalSince($0.value) < 60 }
    }

    /// 0..<1 while a day glides along the track; nil before and after.
    func glide(_ day: String, at now: Date) -> Double? {
        Self.running(glides[day], over: Self.glideDuration, at: now)
    }

    /// 0..<1 while a clear day arcs into the compass; nil before and after.
    func arc(_ day: String, at now: Date) -> Double? {
        Self.running(arcs[day], over: Self.arcDuration, at: now)
    }

    /// Clear days that have reached the compass (or never needed to travel).
    func landed(_ days: [SiteHistoryStatus.Day], at now: Date) -> Int {
        days.count { day in day.type == .clear && arcs[day.day].map { now >= $0 + Self.arcDuration } ?? true }
    }

    /// When the last scheduled glide or arc finishes; nil when nothing was ever scheduled.
    var motionEnd: Date? {
        let ends = glides.values.map { $0 + Self.glideDuration } + arcs.values.map { $0 + Self.arcDuration }
        return ends.max()
    }

    func isAnimating(at now: Date) -> Bool {
        motionEnd.map { now < $0 } ?? false
    }

    private static func running(_ start: Date?, over duration: Double, at now: Date) -> Double? {
        guard let start, now >= start else { return nil }
        let progress = now.timeIntervalSince(start) / duration
        return progress < 1 ? progress : nil
    }
}

/// The tab bar's accessory while the solar system is being found: a tiny compass, the title and
/// day count, and a track where a dot glides in for each downloaded day. Inline it is just the
/// compass and the track. Without a location it asks for one instead. A system found while nobody
/// was watching waits here until it is opened.
@available(iOS 26.0, *)
struct SolarSystemBanner: View {
    let model: SolarSystemBannerModel
    /// Kept by the tab view and fed every change of days.
    let clocks: SolarSystemBannerClocks
    let onOpen: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// True from a new glide or arc until the last one ends; the timeline sleeps otherwise.
    @State private var isMoving = false

    private var isInline: Bool { placement == .inline }
    private var radius: CGFloat { isInline ? 11 : 15 }
    private static let foundWedgeWidth = 18.0

    var body: some View {
        Button(action: onOpen) {
            Group {
                switch model.mode {
                case .needsLocation: needsLocation
                case .found: found
                case .loading: loading
                }
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityHint("Opens Solar System in Settings")
        .accessibilityAddTraits(.isButton)
    }

    private var needsLocation: some View {
        HStack(spacing: 10) {
            Image(systemName: "mappin.and.ellipse").foregroundStyle(SolarSystemColors.clear)
            Text("Add your location to find your solar system")
                .font(.subheadline)
                .lineLimit(isInline ? 1 : 2)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 0)
        }
    }

    /// Waits, still, until opened: the compass closed on the direction that was found.
    private var found: some View {
        HStack(spacing: 10) {
            Canvas { canvas, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                drawCompass(canvas, center: center, azimuth: model.wedgeCenter, width: Self.foundWedgeWidth)
            }
            .frame(width: 2 * radius, height: 2 * radius)
            .accessibilityHidden(true)
            if isInline {
                Text(model.inlineTitle).font(.subheadline.weight(.semibold)).minimumScaleFactor(0.8)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    Text(model.title).font(.subheadline.weight(.semibold)).minimumScaleFactor(0.8)
                    Text(model.detailText).font(.caption).foregroundStyle(.secondary).minimumScaleFactor(0.8)
                }
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
    }

    private var loading: some View {
        // Only while loading in the foreground (the banner shows only then), not waiting, and a dot
        // is moving: between slices the drawing is still, so the timeline sleeps.
        let animates = !reduceMotion && !model.isPaused && scenePhase == .active && isMoving
        return TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animates)) { context in
            HStack(spacing: 10) {
                Color.clear.frame(width: 2 * radius, height: 2 * radius)
                if !isInline {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(SiteHistoryPresentation.title).font(.subheadline.weight(.semibold))
                            .minimumScaleFactor(0.8)
                        Text(model.countText).font(.caption).foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
                Color.clear.frame(width: isInline ? nil : 96, height: 2 * radius)
                    .frame(maxWidth: isInline ? .infinity : nil)
            }
            .overlay {
                Canvas { canvas, size in
                    // A paused timeline keeps the date it paused at; a still frame draws the settled state.
                    let settled = max(context.date, .now)
                    draw(canvas, size: size, now: reduceMotion ? .distantFuture : animates ? context.date : settled)
                }
                .allowsHitTesting(false)
            }
        }
        .task(id: clocks.motionEnd) {
            guard let end = clocks.motionEnd, end > .now else {
                isMoving = false
                return
            }
            isMoving = true
            try? await Task.sleep(for: .seconds(end.timeIntervalSinceNow))
            if !Task.isCancelled { isMoving = false }
        }
    }

    // MARK: - Drawing

    private func draw(_ context: GraphicsContext, size: CGSize, now: Date) {
        let center = CGPoint(x: radius, y: size.height / 2)
        func rim(_ azimuth: Double) -> CGPoint { rimPoint(azimuth, center: center) }
        var compass = context
        compass.opacity = model.isPaused ? 0.45 : 1
        let landed = clocks.landed(model.days, at: now)
        let width = landed > 0
            ? SolarSystemWedge.bannerWidth(clearDays: landed, fittedRange: model.fittedRange) : nil
        drawCompass(compass, center: center, azimuth: model.wedgeCenter, width: width)
        let trackRight = size.width - 4
        let trackLeft = isInline ? 2 * radius + 10 : max(trackRight - 96, 2 * radius + 10)
        let ease = SolarSystemSceneClocks.ease
        for day in model.days.suffix(30) {
            if let glide = clocks.glide(day.day, at: now) {
                let along = trackRight - (trackRight - trackLeft) * ease(glide)
                let fade = min(glide * 4, 1) * (1 - min(max((glide - 0.85) / 0.15, 0), 1))
                dot(context, CGPoint(x: along, y: center.y), radius: 2.6, type: day.type, opacity: fade)
            } else if let arc = clocks.arc(day.day, at: now) {
                let target = rim(model.wedgeCenter)
                let start = CGPoint(x: trackLeft, y: center.y)
                let control = CGPoint(x: (start.x + target.x) / 2, y: min(start.y, target.y) - 16)
                let point = SolarSystemFlightCanvas.bezier(start, control, target, ease(arc))
                dot(context, point, radius: 2.8, type: .clear, opacity: 1)
            }
        }
    }

    private func rimPoint(_ azimuth: Double, center: CGPoint) -> CGPoint {
        let radians = azimuth * .pi / 180
        return CGPoint(x: center.x + sin(radians) * radius, y: center.y - cos(radians) * radius)
    }

    /// The ring and, once there's a direction, its wedge and center line.
    private func drawCompass(_ context: GraphicsContext, center: CGPoint, azimuth: Double, width: Double?) {
        let ring = Path(ellipseIn: CGRect(
            x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius))
        context.stroke(ring, with: .color(SolarSystemColors.ring), lineWidth: 1)
        guard let width else { return }
        var wedge = Path()
        wedge.move(to: center)
        for step in 0 ... 16 {
            wedge.addLine(to: rimPoint(azimuth - width / 2 + width * Double(step) / 16, center: center))
        }
        wedge.closeSubpath()
        context.fill(wedge, with: .color(SolarSystemColors.wedge.opacity(0.55)))
        var line = Path()
        line.move(to: center)
        line.addLine(to: rimPoint(azimuth, center: center))
        context.stroke(line, with: .color(SolarSystemColors.ray), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
    }

    private func dot(
        _ context: GraphicsContext, _ point: CGPoint, radius: CGFloat, type: SolarDayType?, opacity: Double
    ) {
        let shape = Path(ellipseIn: CGRect(
            x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius))
        if type == .noProduction {
            context.stroke(shape, with: .color(SolarSystemColors.noProduction.opacity(opacity)),
                           style: StrokeStyle(lineWidth: 1, dash: [1.5, 1.5]))
        } else {
            context.fill(shape, with: .color(SolarSystemColors.color(type).opacity(opacity)))
        }
    }
}
