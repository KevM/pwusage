@testable import PWUsageCore
import Testing

@Suite("Rate input parsing")
struct RateInputTests {
    @Test("Rejects more than five decimal places and negative values")
    func rejectsMoreThanFiveDecimalsAndNegativeValues() {
        #expect(RateInput.parse("0.30335") == .success(0.30335))
        #expect(RateInput.parse("0.123456") == .failure(.tooManyDecimalPlaces))
        #expect(RateInput.parse("-0.01") == .failure(.negativeOrInvalid))
        #expect(RateInput.parse("") == .failure(.empty))
        #expect(RateInput.parse("12.5") == .failure(.exceedsMaximum))
    }
}
