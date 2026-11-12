import Foundation

enum RateInputError: Error, Equatable, Sendable {
    case empty
    case negativeOrInvalid
    case tooManyDecimalPlaces
    case exceedsMaximum
}

enum RateFormatting {
    static func formatRate(_ value: Double, currency: String) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(
            .currency(code: currency)
                .precision(.fractionLength(2 ... 5))
        )
    }

    static func parseRate(_ rawText: String) -> Result<Double, RateInputError> {
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
