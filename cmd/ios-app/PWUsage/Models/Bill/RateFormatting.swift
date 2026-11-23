import Foundation
import PWUsageCore

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
        // Keep the app error type because the pricing field displays its localized description.
        RateInput.parse(rawText).mapError { error in
            switch error {
            case .empty: .empty
            case .negativeOrInvalid: .negativeOrInvalid
            case .tooManyDecimalPlaces: .tooManyDecimalPlaces
            case .exceedsMaximum: .exceedsMaximum
            }
        }
    }
}
