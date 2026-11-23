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
}
