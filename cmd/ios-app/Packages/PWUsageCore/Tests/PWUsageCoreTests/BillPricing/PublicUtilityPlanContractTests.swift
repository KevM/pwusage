import Foundation
@testable import PWUsageCore
import Testing

@Suite("Public utility plan contracts")
struct PublicUtilityPlanContractTests {
    @Test("Public plans decode with and without rate details")
    func decodesPublicPlans() throws {
        let old = try JSONDecoder().decode(
            UtilityPlanDTO.self, from: Data(#"{"label":"a","name":"Residential","startDate":"2025-01-01"}"#.utf8)
        )
        #expect(old.seasons == nil)
        let json = """
        {"utilityName":"We Energies","effectiveDate":"2025-03-01","currency":"USD","unit":"kWh","plans":[
          {"label":"a","name":"Residential","utilityName":"We Energies","startDate":"2025-01-01",
           "revisionStart":"2025-01-01","kind":"time_of_use","isDefault":true,"currency":"USD","unit":"kWh",
           "holidaysUseWeekendSchedule":true,"exportRateProvenance":"published","seasons":[],
           "approximationNotes":[]}]}
        """
        let response = try JSONDecoder().decode(PublicUtilityPlansResponse.self, from: Data(json.utf8))
        let plan = try #require(response.plans.first)
        #expect(plan.kind == .timeOfUse)
        #expect(plan.exportRateProvenance == .published)
        #expect(plan.seasons == [])
    }
}
