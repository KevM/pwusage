import Foundation
import PWUsageCore

/// Serves a sample `pwusage-rate-plan-handoff/v1` Markdown prompt in Demo Mode so visitors can
/// inspect the exact prompt format and confirm no personal information is included.
extension DemoAPI {
    private static let demoImportUnavailableMessage =
        "Importing AI replies isn't available in the demo. Sign in with your Tesla account to review and apply changes."

    func exportRatePlanAiHandoff(siteID _: String) async throws -> TariffAiHandoffExportResponse {
        let exportedAt = RatePlanTimelineFormatting.formatYMD(now(), in: DemoFixtures.timeZone)
        let markdown = Self.buildDemoAiHandoffMarkdown(exportedAt: exportedAt)
        return TariffAiHandoffExportResponse(
            markdown: markdown,
            filename: "pwusage-demo-rate-plans-\(exportedAt).md"
        )
    }

    func previewRatePlanAiHandoff(
        siteID _: String,
        rawInput _: String
    ) async throws -> TariffAiHandoffPreviewResponse {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: Self.demoImportUnavailableMessage)
    }

    func commitRatePlanAiHandoff(
        siteID _: String,
        commit _: TariffAiHandoffCommitRequest
    ) async throws -> TariffAiHandoffCommitResponse {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: Self.demoImportUnavailableMessage)
    }

    private static func buildDemoAiHandoffMarkdown(exportedAt: String) -> String {
        let header = demoHandoffHeader(exportedAt: exportedAt)
        let jsonBlock = demoHandoffJSON(exportedAt: exportedAt)
        return """
        \(header)

        ## Current Rate Plans JSON

        ```json
        \(jsonBlock)
        ```
        """
    }

    private static func demoHandoffHeader(exportedAt: String) -> String {
        """
        # PWUsage Rate Plan Cross-Check for Your AI Assistant (Demo Sample)

        > **Demo Mode Sample:** This prompt uses fictional **\(DemoFixtures.demoUtilityName)** data \
        so you can see exactly what PWUsage shares with your AI assistant. Only your utility name, \
        timezone, currency, and rate schedules are included — never your name, address, account \
        number, or meter ID.

        ## Instructions for the AI Assistant

        You are helping a homeowner verify and update their electric utility rate plans in \
        **PWUsage** (a Tesla Powerwall energy monitoring and savings app).

        - **Demo notice:** The data below is a Demo Mode sample for a fictional utility \
        (`\(DemoFixtures.demoUtilityName)`). If the user is trying out the workflow, explain how \
        you would check their real utility's tariff sheets or a recent utility bill.
        - **Privacy rule:** If a user provides a utility bill, ignore and never output account \
        numbers, meter numbers, customer names, or service addresses.

        ## Site Context & Rate Metadata

        - **Mode**: Demo Mode (sample data)
        - **Utility**: \(DemoFixtures.demoUtilityName)
        - **Country**: US
        - **Timezone**: \(DemoFixtures.timeZone.identifier)
        - **Currency**: USD
        - **History Start Date (System Installed)**: \(DemoFixtures.siteInstalled)
        - **Exported Date**: \(exportedAt)
        - **Holiday Schedule Rule**: Observed holidays use the weekend schedule (`weekendPeriods`).
        """
    }

    private static func demoHandoffJSON(exportedAt: String) -> String {
        let windows = demoHandoffWindows()
        let payload = DemoHandoffPayload(
            schema: RatePlanAiHandoffModel.expectedSchema,
            utilityName: DemoFixtures.demoUtilityName,
            countryCode: "US",
            currency: "USD",
            timeZone: DemoFixtures.timeZone.identifier,
            historyStart: DemoFixtures.siteInstalled,
            exportedAt: exportedAt,
            notes: ["Demo mode sample — fictional \(DemoFixtures.demoUtilityName) rates, no personal information."],
            sources: [],
            actualPeriods: [
                DemoHandoffPeriod(
                    name: DemoFixtures.tariffName,
                    effectiveFrom: "2026-01-01",
                    effectiveTo: nil,
                    seasons: [
                        DemoHandoffSeason(
                            name: "All year",
                            fromMonth: 1,
                            toMonth: 12,
                            weekdayPeriods: windows.weekday,
                            weekendPeriods: windows.weekend
                        )
                    ]
                )
            ],
            referencePeriods: []
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(payload), let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    private static func demoHandoffWindows() -> (weekday: [TimePeriodWindowInput], weekend: [TimePeriodWindowInput]) {
        let off = DemoFixtures.offPeak
        let peak = DemoFixtures.onPeak
        let weekday = [
            TimePeriodWindowInput(
                touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0,
                buyRate: off.buy, sellRate: off.sell
            ),
            TimePeriodWindowInput(
                touName: .onPeak, fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0,
                buyRate: peak.buy, sellRate: peak.sell
            ),
            TimePeriodWindowInput(
                touName: .offPeak, fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0,
                buyRate: off.buy, sellRate: off.sell
            )
        ]
        let weekend = [
            TimePeriodWindowInput(
                touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0,
                buyRate: off.buy, sellRate: off.sell
            )
        ]
        return (weekday, weekend)
    }
}

private struct DemoHandoffPayload: Encodable {
    let schema: String
    let utilityName: String
    let countryCode: String
    let currency: String
    let timeZone: String
    let historyStart: String
    let exportedAt: String
    let notes: [String]
    let sources: [String]
    let actualPeriods: [DemoHandoffPeriod]
    let referencePeriods: [DemoHandoffPeriod]
}

private struct DemoHandoffPeriod: Encodable {
    let name: String
    let effectiveFrom: String
    let effectiveTo: String?
    let seasons: [DemoHandoffSeason]

    enum CodingKeys: String, CodingKey {
        case name, effectiveFrom, effectiveTo, seasons
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
        try container.encode(seasons, forKey: .seasons)
    }
}

private struct DemoHandoffSeason: Encodable {
    let name: String
    let fromMonth: Int
    let toMonth: Int
    let weekdayPeriods: [TimePeriodWindowInput]
    let weekendPeriods: [TimePeriodWindowInput]
}
