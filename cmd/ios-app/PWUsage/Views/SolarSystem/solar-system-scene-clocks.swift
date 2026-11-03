import Foundation

/// When things landed while the Solar System visual was on screen. The first observation records
/// nothing, so opening the screen (or relaunching) shows the current state without replaying it;
/// later ones start the grow-in of new days, the flights of newly clear days and the found sequence.
struct SolarSystemSceneClocks: Equatable {
    static let growDuration = 0.35
    static let flightDuration = 0.9
    static let rayDuration = 0.3
    static let foundDuration = 3.4

    private(set) var appeared: [String: Date] = [:]
    private(set) var flights: [String: Date] = [:]
    private(set) var foundAt: Date?
    private var known: Set<String>?
    private var knownClear: Set<String> = []
    private var hadLayout = false

    mutating func observe(days: [SiteHistoryStatus.Day], hasLayout: Bool, now: Date) {
        let ids = Set(days.map(\.day))
        let clear = Set(days.filter { $0.type == .clear }.map(\.day))
        if let known {
            // The newest new day first, as the strip grows outward from it.
            for (index, day) in ids.subtracting(known).sorted(by: >).enumerated() {
                appeared[day] = now.addingTimeInterval(Double(min(index, 20)) * 0.03)
            }
            for (index, day) in clear.subtracting(knownClear).sorted().enumerated() {
                flights[day] = now.addingTimeInterval(0.2 + Double(min(index, 30)) * 0.06)
            }
            if hasLayout, !hadLayout { foundAt = now }
            if !hasLayout { foundAt = nil }
        }
        known = ids
        knownClear = clear
        hadLayout = hasLayout
        prune(now: now)
    }

    /// 0 before a day starts growing in, 1 once grown (or when it never animated).
    func growth(_ day: String, at now: Date) -> Double {
        guard let start = appeared[day] else { return 1 }
        return Self.progress(now.timeIntervalSince(start), over: Self.growDuration)
    }

    /// A clear day's flight to the rim (0...1), then its ray stretching inward (0...1). Days that
    /// never flew are already rays.
    func flight(_ day: String, at now: Date) -> (travel: Double, ray: Double) {
        guard let start = flights[day] else { return (1, 1) }
        let elapsed = now.timeIntervalSince(start)
        return (Self.progress(elapsed, over: Self.flightDuration),
                Self.progress(elapsed - Self.flightDuration, over: Self.rayDuration))
    }

    /// 0...1 through the found sequence; 1 when it never animated.
    func found(at now: Date) -> Double {
        guard let foundAt else { return 1 }
        return Self.progress(now.timeIntervalSince(foundAt), over: Self.foundDuration)
    }

    func isAnimating(at now: Date) -> Bool {
        let growing = appeared.values.contains { now.timeIntervalSince($0) < Self.growDuration }
        let flying = flights.values.contains {
            now.timeIntervalSince($0) < Self.flightDuration + Self.rayDuration
        }
        let finding = foundAt.map { now.timeIntervalSince($0) < Self.foundDuration } ?? false
        return growing || flying || finding
    }

    private mutating func prune(now: Date) {
        appeared = appeared.filter { now.timeIntervalSince($0.value) < 30 }
        flights = flights.filter { now.timeIntervalSince($0.value) < 30 }
    }

    static func progress(_ elapsed: TimeInterval, over duration: TimeInterval) -> Double {
        min(max(elapsed / duration, 0), 1)
    }
}
