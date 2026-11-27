#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif
#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#elseif canImport(WASILibc)
    import WASILibc
#endif

public struct ShadeSegment: Equatable, Sendable {
    public var azimuthFrom: Double
    public var azimuthTo: Double
    public var belowElevation: Double

    public init(azimuthFrom: Double, azimuthTo: Double, belowElevation: Double) {
        self.azimuthFrom = azimuthFrom
        self.azimuthTo = azimuthTo
        self.belowElevation = belowElevation
    }
}

/// A strong-deficit bin above the horizon: 10 degrees of azimuth by 5 degrees of elevation.
public struct ShadeHotBin: Equatable, Sendable {
    public let azimuth: Double
    public let elevation: Double

    public init(azimuth: Double, elevation: Double) {
        self.azimuth = azimuth
        self.elevation = elevation
    }
}

/// Learned horizon profile (one value per 10 degrees of azimuth) plus isolated hot bins.
public struct ShadeMask: Sendable {
    public let horizon: [Double]
    public let hotBins: [ShadeHotBin]
    public let observedBins: [Bool]

    public init(horizon: [Double], hotBins: [ShadeHotBin], observedBins: [Bool] = []) {
        self.horizon = horizon
        self.hotBins = hotBins
        self.observedBins = observedBins
    }

    public func shaded(azimuth: Double, elevation: Double) -> Bool {
        guard azimuth.isFinite else { return false }
        let bin = Int(min(max(floor(azimuth / 10), 0), Double(horizon.count - 1)))
        if elevation <= horizon[bin] { return true }
        return hotBins.contains { hot in
            azimuth >= hot.azimuth && azimuth < hot.azimuth + 10
                && elevation >= hot.elevation && elevation < hot.elevation + 5
        }
    }

    /// Horizon profile merged into contiguous segments (reference `summary` / `_merge_segments`).
    public func summary() -> [ShadeSegment] {
        var out: [ShadeSegment] = []
        for (bin, height) in horizon.enumerated() where height.isFinite {
            if let last = out.last, last.azimuthTo == Double(bin * 10), abs(last.belowElevation - height) <= 5 {
                out[out.count - 1].azimuthTo = Double((bin + 1) * 10)
                out[out.count - 1].belowElevation = max(last.belowElevation, height)
            } else {
                out.append(ShadeSegment(
                    azimuthFrom: Double(bin * 10), azimuthTo: Double((bin + 1) * 10), belowElevation: height))
            }
        }
        return out
    }
}
