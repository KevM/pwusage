import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Rate plan history copy")
struct RatePlanHistoryPresentationTests {
    private static func plan(
        _ name: String, kind: RatePlanKind = .timeOfUse, low: Double = 0.1, high: Double = 0.27,
        closest: Bool = false, isDefault: Bool = false, windows: [RatePlanPeakWindowDTO] = []
    ) -> RatePlanHistoryPlanDTO {
        RatePlanHistoryPlanDTO(
            name: name, startDate: "2025-01-01", kind: kind, isDefault: isDefault, closest: closest,
            lowRate: low, highRate: high, peakWindows: windows, closestWindow: nil, fixedLabel: nil
        )
    }

    private static let optionB = RatePlanPeakWindowDTO(label: "B", fromHour: 8, toHour: 20)

    private static func history(years: [Int] = [2025, 2024, 2023]) -> RatePlanHistoryDTO {
        RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2026-04-27",
            teslaShape: .timeOfUse, current: [plan("Residential Rg 1", kind: .fixed, low: 0.19)],
            years: years.map {
                RatePlanHistoryYearDTO(
                    year: $0, askDate: "\($0)-07-01", plans: [plan("Residential Rg 1", kind: .fixed)]
                )
            }
        )
    }

    @Test func offerCopy() {
        #expect(RatePlanHistoryPresentation.accessoryTitle == "Find your past rate plans")
        #expect(RatePlanHistoryPresentation.accessorySubtitle(utilityName: "We Energies", historyStart: "2023-11-14")
            == "We Energies · since Nov 2023")
        #expect(RatePlanHistoryPresentation.offerMessage(historyStart: "2023-11-14")
            == "Your system has been running since Nov 2023. Want help finding the rate plans you’ve been on?")
        #expect(RatePlanHistoryPresentation.findButtonTitle == "Find My Rate Plans")
        #expect(RatePlanHistoryPresentation.notNowButtonTitle == "Not Now")
        #expect(RatePlanHistoryPresentation.notNowLabel == "Not now")
    }

    @Test func pricesUseTwoDecimals() {
        #expect(RatePlanHistoryPresentation.price(0.1) == "$0.10")
        #expect(RatePlanHistoryPresentation.fixedPrice(0.19) == "$0.19/kWh")
        let timeOfUse = Self.plan("A", low: 0.1, high: 0.27)
        #expect(RatePlanHistoryPresentation.priceRow(timeOfUse) == "Off-Peak $0.10 · Peak $0.27")
        #expect(RatePlanHistoryPresentation.priceRow(Self.plan("B", kind: .fixed, low: 0.19)) == "$0.19/kWh")
    }

    @Test func hoursUseTwelveHourClock() {
        #expect(RatePlanHistoryPresentation.windowRow(Self.optionB) == "8 AM – 8 PM")
        #expect(RatePlanHistoryPresentation.hourLabel(0) == "12 AM")
        #expect(RatePlanHistoryPresentation.hourLabel(12) == "12 PM")
        #expect(RatePlanHistoryPresentation.hourLabel(24) == "12 AM")
        #expect(RatePlanHistoryPresentation.hourLabel(13) == "1 PM")
    }

    @Test func displayNamesDropSinglePhase() {
        #expect(RatePlanHistoryPresentation.displayName("Residential Rg 1 (Single-Phase)") == "Residential Rg 1")
        #expect(RatePlanHistoryPresentation.displayName("Residential Single-Phase  Rg 1") == "Residential Rg 1")
        #expect(RatePlanHistoryPresentation.displayName("Time-of-Use Rg 2") == "Time-of-Use Rg 2")
    }

    @Test func pills() {
        #expect(RatePlanHistoryPresentation.planPill(Self.plan("A", closest: true, isDefault: true))
            == "Closest to your Tesla plan")
        #expect(RatePlanHistoryPresentation.planPill(Self.plan("A", isDefault: true)) == "Standard plan")
        #expect(RatePlanHistoryPresentation.planPill(Self.plan("A")) == nil)
        #expect(RatePlanHistoryPresentation.assumedPill == "Assumed")
        #expect(RatePlanHistoryPresentation.kindMatchesTeslaPill == "Matches your Tesla rate plan")
        #expect(RatePlanHistoryPresentation.hoursMatchTeslaPill == "Matches your Tesla plan")
    }

    @Test func kindOptionsAndExamples() {
        let plans = [
            Self.plan("TOU A", low: 0.12, high: 0.3),
            Self.plan("TOU B", low: 0.1, high: 0.27, closest: true),
            Self.plan("Fixed A", kind: .fixed, low: 0.21),
            Self.plan("Fixed B", kind: .fixed, low: 0.19)
        ]
        #expect(RatePlanHistoryPresentation.kinds(in: plans) == [.fixed, .timeOfUse])
        #expect(RatePlanHistoryPresentation.kinds(in: [plans[0]]) == [.timeOfUse])
        #expect(RatePlanHistoryPresentation.kindDetail(.fixed, in: plans) == "One price all day, like $0.19/kWh")
        #expect(RatePlanHistoryPresentation.kindDetail(.timeOfUse, in: plans)
            == "Off-Peak and Peak prices, like $0.10 and $0.27")
        #expect(RatePlanHistoryPresentation.kindDetail(.fixed, in: [plans[0]]) == nil)
        #expect(RatePlanHistoryPresentation.kindTitle(.fixed) == "Fixed")
        #expect(RatePlanHistoryPresentation.kindTitle(.timeOfUse) == "Time of Use")
    }

    @Test func questionsAndTitles() {
        var flow = RatePlanHistoryFlow(history: Self.history(), hasTeslaPlan: true)
        // With a Tesla plan the guide fills up to its start, so it asks about the plan there.
        #expect(RatePlanHistoryPresentation.question(flow) == "What kind of rate plan were you on in Apr 2026?")
        #expect(RatePlanHistoryPresentation.navigationTitle(flow) == "Your Rate Plans")
        flow.chooseKind(.fixed)
        #expect(flow.step == .sinceStart)
        #expect(RatePlanHistoryPresentation.question(flow) == "Have you been on Residential Rg 1 since Nov 2023?")
        #expect(RatePlanHistoryPresentation.navigationTitle(flow) == "Your Rate Plans")
        flow.answerSinceStart(true)
        #expect(flow.step == .review)
        #expect(RatePlanHistoryPresentation.navigationTitle(flow) == "Review")
        #expect(RatePlanHistoryPresentation.question(flow) == "Your rate plans since Nov 2023")
    }

    @Test func questionsAboutThePlanBefore() {
        let history = RatePlanHistoryDTO(
            utilityName: "U", historyStart: "2023-11-14", fillThrough: nil, teslaShape: nil,
            current: [Self.plan("Current Plan", kind: .fixed)],
            years: [RatePlanHistoryYearDTO(
                year: 2024, askDate: "2024-07-01",
                plans: [Self.plan("Other", kind: .fixed), Self.plan("Other 2", kind: .fixed)]
            )]
        )
        var flow = RatePlanHistoryFlow(history: history, hasTeslaPlan: false, today: "2026-11-16")
        #expect(RatePlanHistoryPresentation.question(flow) == "What kind of rate plan are you on now?")
        flow.chooseKind(.fixed)
        flow.answerSinceStart(false)
        #expect(RatePlanHistoryPresentation.question(flow) == "When did you switch to Current Plan?")
        flow.chooseSwitchMonth("2025-01")
        #expect(flow.step == .kind(year: 2024))
        #expect(RatePlanHistoryPresentation.question(flow) == "What kind of rate plan were you on before Jan 2025?")
        flow.chooseKind(.fixed)
        #expect(RatePlanHistoryPresentation.question(flow) == "Which plan were you on before Jan 2025?")
        flow.choosePlan(history.years[0].plans[1])
        #expect(RatePlanHistoryPresentation.question(flow)
            == "Before Jan 2025, had you been on Other 2 since Nov 2023?")
    }

    @Test func helpSheetCopy() {
        #expect(RatePlanHistoryPresentation.helpTitle == "Which Kind Is It?")
        #expect(RatePlanHistoryPresentation.helpTimeOfUseBullets == [
            "• Separate “On-peak” and “Off-peak” kWh lines",
            "• The words “Time of Use”, “TOU” or “Time-of-Day”"
        ])
        #expect(RatePlanHistoryPresentation.helpFixedBullets == [
            "• One kWh line at one price", "• “Residential service” or “Standard”"
        ])
        #expect(RatePlanHistoryPresentation.planCodesTitle(utilityName: "We Energies") == "We Energies plan codes")
        #expect(RatePlanHistoryPresentation.planCodeRow(Self.plan("Rg 1 (Single-Phase)", kind: .fixed))
            == "Rg 1 · Fixed")
        #expect(RatePlanHistoryPresentation.stillNotSureCaption(hasTeslaPlan: true)
            == "We’ll go with your Tesla rate plan.")
        #expect(RatePlanHistoryPresentation.stillNotSureCaption(hasTeslaPlan: false)
            == "We’ll go with your utility’s standard plan.")
    }

    @Test func reviewCopy() {
        let span = RatePlanHistoryFlow.Span(
            plan: Self.plan("Time-of-Use (Single-Phase)", windows: [Self.optionB]), windowLabel: "B",
            from: "2024-03-01", endDate: "2025-12-31", assumed: false
        )
        #expect(RatePlanHistoryPresentation.spanTitle(span) == "Time-of-Use · Peak 8 AM – 8 PM")
        #expect(RatePlanHistoryPresentation.spanRange(span) == "Mar 1, 2024 – Dec 31, 2025")
        var fixed = span
        fixed.windowLabel = nil
        #expect(RatePlanHistoryPresentation.spanTitle(fixed) == "Time-of-Use")
        #expect(RatePlanHistoryPresentation.teslaRange(from: "2026-04-28") == "Apr 28, 2026 – Present")
        #expect(RatePlanHistoryPresentation.switchMonthLabel("2025-03") == "March 2025")
        #expect(RatePlanHistoryPresentation.reviewFooter
            == "Priced from public utility rates. You can edit them in Rate Plans.")
        #expect(RatePlanHistoryPresentation.saveTitle == "Save Rate Plans")
        #expect(RatePlanHistoryPresentation.savingTitle == "Saving Rate Plans…")
    }

    @Test func errorMessages() {
        #expect(RatePlanHistoryPresentation.loadFailureMessage
            == "Couldn’t load your utility’s rate plans. Check your connection and try again.")
        #expect(RatePlanHistoryPresentation.saveErrorMessage(for: URLError(.notConnectedToInternet))
            == "Couldn’t save your rate plans. Check your connection and try again.")
        #expect(RatePlanHistoryPresentation.saveErrorMessage(
            for: PWUsageAPIError.requestRejected(statusCode: 409, message: "Rates changed.")) == "Rates changed.")
        #expect(RatePlanHistoryPresentation.saveErrorMessage(
            for: PWUsageAPIError.requestRejected(statusCode: 400, message: nil))
            == "Couldn’t save your rate plans. Check your connection and try again.")
    }

    @Test func teslaRowStartsTheDayAfterTheFilledSpans() {
        let row = RatePlanHistoryPresentation.teslaRow(history: Self.history(), teslaPlanName: "CGS NM (edited)")
        #expect(row == RatePlanHistoryPresentation.TeslaRow(name: "CGS NM (edited)", range: "Apr 28, 2026 – Present"))
        let monthEnd = RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: "2025-12-31",
            teslaShape: nil, current: [], years: []
        )
        #expect(RatePlanHistoryPresentation.teslaRow(history: monthEnd, teslaPlanName: "Tesla")?.range
            == "Jan 1, 2026 – Present")
    }

    @Test func teslaRowIsAbsentWithoutATeslaPlanOrFilledSpans() {
        #expect(RatePlanHistoryPresentation.teslaRow(history: Self.history(), teslaPlanName: nil) == nil)
        #expect(RatePlanHistoryPresentation.teslaRow(history: Self.history(), teslaPlanName: "") == nil)
        let open = RatePlanHistoryDTO(
            utilityName: "We Energies", historyStart: "2023-11-14", fillThrough: nil,
            teslaShape: nil, current: [], years: []
        )
        #expect(RatePlanHistoryPresentation.teslaRow(history: open, teslaPlanName: "Tesla") == nil)
    }
}
