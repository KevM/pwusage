import Foundation

/// Current-vs-baseline performance ratio for a site and its separated faces.
struct SolarHealthBaselineScore: Equatable, Sendable {
    /// Clear-day-weighted mean of current / baseline over calendar months; 1.00 when none compare. Not capped.
    let site: Double
    let comparedMonths: Int
    /// Per face, only faces present in `baseline.directionFactors`; 1.00 for a face with no comparison yet.
    let directions: [SolarHealthCapacity.Direction]
}

extension SolarHealthBaseline {
    /// Compares each calendar month's most recent post-baseline observation against its own baseline.
    func score(of years: [SolarHealthYear]) -> SolarHealthBaselineScore {
        let factorMonths = Self.sortedFactorMonths(from: years)
        let samples = siteSamples(in: factorMonths)
        let directions = directionFactors.map { directionScore(for: $0.azimuth, in: factorMonths) }
        return SolarHealthBaselineScore(
            site: Self.weightedMean(of: samples) ?? 1.0,
            comparedMonths: samples.count,
            directions: directions)
    }

    private func siteSamples(in factorMonths: [Month]) -> [(value: Double, weight: Double)] {
        months.compactMap { monthNumber, base in
            guard base.capacity.site > 0,
                  let current = factorMonths.last(where: {
                      $0.stamp.month == monthNumber && $0.stamp > base.stamp && $0.capacity.site > 0
                  })
            else {
                return nil
            }
            return (current.capacity.site / base.capacity.site, Double(current.capacity.clearDays))
        }
    }

    private func directionScore(
        for azimuth: Double,
        in factorMonths: [Month]
    ) -> SolarHealthCapacity.Direction {
        let samples: [(value: Double, weight: Double)] = months.compactMap { monthNumber, base in
            guard let baseFactor = separatedFactor(for: azimuth, in: base.capacity) else {
                return nil
            }
            var latestFactor: Double?
            var latestClearDays = 0
            for candidate in factorMonths where candidate.stamp.month == monthNumber && candidate.stamp > base.stamp {
                if let factor = separatedFactor(for: azimuth, in: candidate.capacity) {
                    latestFactor = factor
                    latestClearDays = candidate.capacity.clearDays
                }
            }
            guard let currentFactor = latestFactor else { return nil }
            return (currentFactor / baseFactor, Double(latestClearDays))
        }
        return SolarHealthCapacity.Direction(
            azimuth: azimuth,
            factor: Self.weightedMean(of: samples) ?? 1.0)
    }

    private func separatedFactor(for azimuth: Double, in capacity: SolarHealthCapacity) -> Double? {
        guard capacity.directions.count == faceCount,
              let match = capacity.directions.first(where: { Self.azimuthMatches($0.azimuth, azimuth) }),
              match.factor > 0
        else {
            return nil
        }
        return match.factor
    }
}
