import Foundation

/// Display strings and emphasis flags for the Panel Health card and Potential vs actual caption.
struct SolarHealthScorePresentation: Equatable {
    struct DirectionRow: Equatable {
        let azimuth: Double
        let value: String
    }

    static let waitingForClearDays = "Learning your system · waiting for clear days"

    let headline: String
    let headlineDetail: String?
    let band: String
    let isEmphasized: Bool
    let efficiencyLabel: String
    let efficiencyValue: String
    let olderPanelsNote: String?
    let restartNote: String?
    let directionRows: [DirectionRow]
    let panelCheckPrompt: String?

    init(score: SolarHealthReport.HealthScore, locale: Locale = .current) {
        let percentStyle = FloatingPointFormatStyle<Double>.Percent.percent
            .precision(.fractionLength(0))
            .locale(locale)
        let numberStyle = IntegerFormatStyle<Int>.number.locale(locale)

        (headline, headlineDetail) = Self.makeHeadline(
            score: score,
            percentStyle: percentStyle,
            numberStyle: numberStyle)

        let bandPercent = (score.bandPercent / 100).formatted(percentStyle)
        band = "(±\(bandPercent))"
        isEmphasized = score.isBelowBand

        let baseEfficiencyLabel: String
        switch score.baseline.label {
        case .asNew:
            baseEfficiencyLabel = "When new"
            olderPanelsNote = nil
        case let .firstYear(year):
            baseEfficiencyLabel = "In \(year)"
            olderPanelsNote = "Older panels usually sit lower in this range."
        }
        efficiencyLabel = score.isProvisional ? "\(baseEfficiencyLabel) (so far)" : baseEfficiencyLabel
        efficiencyValue = Self.makeEfficiencyValue(
            score: score,
            percentStyle: percentStyle,
            numberStyle: numberStyle)

        restartNote = score.baseline.restartYear.map {
            "Baseline restarted when the \($0) system was added"
        }

        directionRows = Self.makeDirectionRows(score: score, percentStyle: percentStyle)

        panelCheckPrompt = score.isAboveHealthyRange
            ? "Your system makes more than its entered rating allows. Check the panel count and wattage."
            : nil
    }

    private static func makeHeadline(
        score: SolarHealthReport.HealthScore,
        percentStyle: FloatingPointFormatStyle<Double>.Percent,
        numberStyle: IntegerFormatStyle<Int>
    ) -> (String, String?) {
        let unit = score.baseline.relativeUnit
        let scorePercent = score.scoreVsNew.formatted(percentStyle)
        guard score.isProvisional else {
            return ("\(scorePercent) \(unit)", nil)
        }
        let seasons = score.baseline.seasonsCovered.formatted(numberStyle)
        let totalSeasons = 4.formatted(numberStyle)
        let clearDays = score.baseline.clearDays.formatted(numberStyle)
        let progress = "\(seasons) of \(totalSeasons) seasons · \(clearDays) clear days"
        if score.comparedMonths == 0 {
            return ("Learning your system", progress)
        }
        return ("\(scorePercent) \(unit)", "Learning your system · \(progress)")
    }

    private static func makeEfficiencyValue(
        score: SolarHealthReport.HealthScore,
        percentStyle: FloatingPointFormatStyle<Double>.Percent,
        numberStyle: IntegerFormatStyle<Int>
    ) -> String {
        let rated = score.ratedEfficiency.formatted(percentStyle)
        let nameplate = SolarSystemDetailsRows.kilowatts(score.nameplateKw)
        let low = Int((SolarHealthClassifier.healthyEfficiencyRange.lowerBound * 100).rounded())
            .formatted(numberStyle)
        let high = SolarHealthClassifier.healthyEfficiencyRange.upperBound.formatted(percentStyle)
        return "\(rated) of its \(nameplate) rating · healthy range \(low)–\(high)"
    }

    private static func makeDirectionRows(
        score: SolarHealthReport.HealthScore,
        percentStyle: FloatingPointFormatStyle<Double>.Percent
    ) -> [DirectionRow] {
        guard score.perDirection.count > 1 else { return [] }
        let unit = score.baseline.relativeUnit
        return score.perDirection.map { direction in
            DirectionRow(
                azimuth: direction.azimuth,
                value: "\(direction.factor.formatted(percentStyle)) \(unit)")
        }
    }

    static func potentialCaption(
        _ pva: SolarHealthReport.PotentialVsActual,
        locale: Locale = .current
    ) -> String {
        let kwhStyle = FloatingPointFormatStyle<Double>.number
            .precision(.fractionLength(1))
            .locale(locale)
        let expected = pva.expectedKwh.formatted(kwhStyle)
        let actual = pva.actualKwh.formatted(kwhStyle)
        if pva.isAsNew {
            return "As new, your system made about \(expected) kWh on a clear day like \(pva.day); "
                + "yours made \(actual) kWh."
        }
        return "Expected \(expected) kWh on a clear day like \(pva.day); yours made \(actual) kWh."
    }
}
