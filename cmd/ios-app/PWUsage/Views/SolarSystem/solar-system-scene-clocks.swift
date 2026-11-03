import Foundation

/// When things landed while the Solar System visual was on screen, on the reveal prototype's
/// timeline. The first observation records nothing, so opening the screen (or relaunching) shows
/// the current state without replaying it; later ones start the grow-in of new days, the flights
/// of newly clear days, the strip's widening and the found sequence.
struct SolarSystemSceneClocks: Equatable {
    static let growDuration = 0.35
    /// A flight from the strip to the rim; its last `melt` fraction stretches into a ray.
    static let flightDuration = 1.1
    static let melt = 0.38
    static let widenDuration = 0.5
    /// The camera tilt, after the last flight lands and a short pause.
    static let buildDelay = 0.4
    static let buildDuration = 2.2
    /// The house starts once the tilt is 45% through: walls 1 s, roof pitch 1 s from 0.9 s,
    /// then panels face by face from 2.1 s, 0.5 s apart, each face over 1.6 s.
    static let houseStart = 0.45 * buildDuration
    static let houseDuration = 2.1 + 3 * 0.5 + 1.6

    private(set) var appeared: [String: Date] = [:]
    private(set) var flights: [String: Date] = [:]
    private(set) var buildStart: Date?
    private struct Widening: Equatable {
        let from: Double
        let target: Double
        let start: Date
    }

    private var widening: Widening?
    private var known: Set<String>?
    private var knownClear: Set<String> = []
    private var knownColumns = 0
    private var hadLayout = false

    mutating func observe(days: [SiteHistoryStatus.Day], columns: Int, hasLayout: Bool, now: Date) {
        let ids = Set(days.map(\.day))
        let clear = Set(days.filter { $0.type == .clear }.map(\.day))
        if let known {
            // The newest new day first, as the strip grows outward from it.
            for (index, day) in ids.subtracting(known).sorted(by: >).enumerated() {
                appeared[day] = now.addingTimeInterval(Double(min(index, 20)) * 0.03)
            }
            for (index, day) in clear.subtracting(knownClear).sorted().enumerated() {
                flights[day] = now.addingTimeInterval(Double(index % 6) * 0.05 + Self.spread(day) * 0.3)
            }
            let shown = widenedColumns(at: now) ?? Double(knownColumns)
            if Double(columns) != shown { widening = Widening(from: shown, target: Double(columns), start: now) }
            if hasLayout, !hadLayout {
                let landed = flights.values.map { $0.addingTimeInterval(Self.flightDuration) }.max() ?? now
                buildStart = max(landed, now).addingTimeInterval(Self.buildDelay)
            }
            if !hasLayout { buildStart = nil }
        }
        known = ids
        knownClear = clear
        knownColumns = columns
        hadLayout = hasLayout
        prune(now: now)
    }

    /// 0 before a day starts growing in, 1 once grown (or when it never animated).
    func growth(_ day: String, at now: Date) -> Double {
        guard let start = appeared[day] else { return 1 }
        return Self.progress(now.timeIntervalSince(start), over: Self.growDuration)
    }

    /// A clear day's flight, 0...1; 1 for days that never flew. Below `1 - melt` the dot is in the
    /// air; above it, it is melting into its ray.
    func flight(_ day: String, at now: Date) -> Double {
        guard let start = flights[day] else { return 1 }
        return Self.progress(now.timeIntervalSince(start), over: Self.flightDuration)
    }

    /// Whether a day's ray is drawn: it has landed (or never flew).
    func hasLanded(_ day: String, at now: Date) -> Bool { flight(day, at: now) >= 1 }

    /// The strip's eased column count while it widens; nil once settled.
    func widenedColumns(at now: Date) -> Double? {
        guard let widening else { return nil }
        let progress = Self.progress(now.timeIntervalSince(widening.start), over: Self.widenDuration)
        guard progress < 1 else { return nil }
        return widening.from + (widening.target - widening.from) * Self.ease(progress)
    }

    /// 0...1 through the camera tilt; 1 when it never animated.
    func build(at now: Date) -> Double {
        guard let buildStart else { return 1 }
        return Self.progress(now.timeIntervalSince(buildStart), over: Self.buildDuration)
    }

    /// Seconds into the house's own build; long past the end when it never animated.
    func houseTime(at now: Date) -> Double {
        guard let buildStart else { return .greatestFiniteMagnitude }
        return now.timeIntervalSince(buildStart) - Self.houseStart
    }

    func isAnimating(at now: Date) -> Bool {
        let growing = appeared.values.contains { now.timeIntervalSince($0) < Self.growDuration }
        let flying = flights.values.contains { now.timeIntervalSince($0) < Self.flightDuration }
        let building = buildStart.map {
            now.timeIntervalSince($0) < Self.houseStart + Self.houseDuration
        } ?? false
        return growing || flying || building || widenedColumns(at: now) != nil
    }

    private mutating func prune(now: Date) {
        appeared = appeared.filter { now.timeIntervalSince($0.value) < 30 }
        flights = flights.filter { now.timeIntervalSince($0.value) < 30 }
    }

    static func progress(_ elapsed: TimeInterval, over duration: TimeInterval) -> Double {
        min(max(elapsed / duration, 0), 1)
    }

    /// Cubic ease in and out, as in the prototypes.
    static func ease(_ value: Double) -> Double {
        let clamped = min(max(value, 0), 1)
        return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - pow(-2 * clamped + 2, 3) / 2
    }

    /// A stable 0..<1 spread from the day.
    static func spread(_ day: String) -> Double {
        let hash = day.unicodeScalars.reduce(UInt32(2_166_136_261)) { ($0 ^ $1.value) &* 16_777_619 }
        return Double(hash % 1000) / 1000
    }
}
