import Foundation

/// A tab's hero block that hands its detail to the navigation bar once it scrolls under it.
enum ScrollHero {
    /// Whether at least 15% of the hero shows below the bar, all in scroll content
    /// coordinates. An unmeasured hero counts as visible.
    static func isVisible(minY: Double, maxY: Double, visibleTop: Double) -> Bool {
        let height = maxY - minY
        guard height > 0 else { return true }
        return maxY - max(visibleTop, minY) >= height * 0.15
    }

    /// The last measured hero frame and scroll edge. A class box, so scrolling
    /// updates them without redrawing; only a visibility flip redraws.
    final class Tracking {
        var frame: CGRect = .zero
        var visibleTop: Double = 0

        var isHeroVisible: Bool {
            ScrollHero.isVisible(minY: frame.minY, maxY: frame.maxY, visibleTop: visibleTop)
        }
    }
}
