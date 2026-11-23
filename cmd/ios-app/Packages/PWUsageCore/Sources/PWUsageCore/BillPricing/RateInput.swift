import Foundation

public enum RateInput {
    public enum ParseError: Error, Equatable, Sendable {
        case empty
        case negativeOrInvalid
        case tooManyDecimalPlaces
        case exceedsMaximum
    }

    public static func parse(_ rawText: String) -> Result<Double, ParseError> {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        guard !trimmed.hasPrefix("-"), let value = Double(trimmed), value.isFinite, value >= 0 else {
            return .failure(.negativeOrInvalid)
        }
        if let dot = trimmed.firstIndex(of: ".") {
            let fractionCount = trimmed.distance(from: trimmed.index(after: dot), to: trimmed.endIndex)
            if fractionCount > 5 { return .failure(.tooManyDecimalPlaces) }
        }
        if value > 10.0 { return .failure(.exceedsMaximum) }
        return .success((value * 100_000).rounded() / 100_000)
    }
}
