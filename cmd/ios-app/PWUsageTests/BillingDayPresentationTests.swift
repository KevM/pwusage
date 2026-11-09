@testable import PWUsage
import Testing

@Suite("Billing day presentation")
struct BillingDayPresentationTests {
    @Test("The row value names the day of the month")
    func rowValue() {
        #expect(BillingDayPresentation.rowValue(day: 1) == "Day 1")
        #expect(BillingDayPresentation.rowValue(day: 22) == "Day 22")
        #expect(BillingDayPresentation.rowValue(day: 31) == "Day 31")
    }

    @Test("Every day a bill can start on is offered, and no other")
    func offeredDays() {
        #expect(BillingDayPresentation.days == Array(1 ... 31))
        #expect(MobileBillingDay.validDays == 1 ... 31)
    }

    @Test("Copy follows the voice guide: plain, calm, no exclamation marks or please")
    func copyIsCalm() {
        let strings = [
            BillingDayPresentation.footer, BillingDayPresentation.promptTitle, BillingDayPresentation.promptMessage,
            BillingDayPresentation.saveFailure
        ]
        for string in strings {
            #expect(!string.contains("!"))
            #expect(!string.lowercased().contains("please"))
            #expect(!string.lowercased().contains("sorry"))
        }
    }
}
