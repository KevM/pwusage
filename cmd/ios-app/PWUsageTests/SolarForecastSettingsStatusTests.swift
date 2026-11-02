@testable import PWUsage
import Testing

@Suite("Solar Forecast Settings Status Tests")
struct SolarForecastSettingsStatusTests {
    @Test("Compass names are accurately mapped from degrees")
    func compassNames() {
        #expect(SolarForecastSettingsStatus.compassName(0) == "north")
        #expect(SolarForecastSettingsStatus.compassName(90) == "east")
        #expect(SolarForecastSettingsStatus.compassName(180) == "south")
        #expect(SolarForecastSettingsStatus.compassName(270) == "west")
    }

    @Test("Kilowatt formatting omits trailing zero")
    func kilowattFormatting() {
        #expect(SolarForecastSettingsStatus.kilowatts(4.0) == "4")
        #expect(SolarForecastSettingsStatus.kilowatts(5.6) == "5.6")
    }

    @Test("Reason sentences match user copy")
    func reasonSentences() {
        #expect(SolarForecastSettingsStatus.sentence(for: .needsLocation).contains("location"))
        #expect(SolarForecastSettingsStatus.sentence(for: .pending).contains("layout"))
    }
}
