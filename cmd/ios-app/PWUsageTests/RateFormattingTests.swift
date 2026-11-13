@testable import PWUsage
import Testing

@Suite("Rate formatting and parsing")
struct RateFormattingTests {
    @Test("Formats two to five decimals without truncating precision")
    func formatsTwoToFiveDecimalsWithoutTruncatingPrecision() {
        #expect(RateFormatting.formatRate(0.1, currency: "USD") == "$0.10")
        #expect(RateFormatting.formatRate(0.30335, currency: "USD") == "$0.30335")
        #expect(RateFormatting.formatRate(0.0005, currency: "USD") == "$0.0005")
    }

    @Test("Rejects more than five decimal places and negative values")
    func rejectsMoreThanFiveDecimalsAndNegativeValues() {
        #expect(RateFormatting.parseRate("0.30335") == .success(0.30335))
        #expect(RateFormatting.parseRate("0.123456") == .failure(.tooManyDecimalPlaces))
        #expect(RateFormatting.parseRate("-0.01") == .failure(.negativeOrInvalid))
        #expect(RateFormatting.parseRate("") == .failure(.empty))
        #expect(RateFormatting.parseRate("12.5") == .failure(.exceedsMaximum))
    }
}
