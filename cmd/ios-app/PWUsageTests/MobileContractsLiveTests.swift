import Foundation
@testable import PWUsage
import Testing

extension MobileContractsTests {
    @Test("Suppresses a battery charge reading older than the two-hour rule")
    func suppressesStaleStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-3 * 3600)))
        )
        #expect(response.stateOfCharge == nil)
    }

    @Test("Suppresses an undated battery charge reading")
    func suppressesUndatedStateOfCharge() throws {
        let absent = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .absent)
        )
        #expect(absent.stateOfCharge == nil)

        let nulled = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: nil)
        )
        #expect(nulled.stateOfCharge == nil)
    }

    @Test("Suppresses a battery charge reading stamped in the future")
    func suppressesFutureStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(60)))
        )
        #expect(response.stateOfCharge == nil)
    }

    @Test("Keeps a battery charge reading taken ten minutes ago")
    func keepsRecentStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(response.stateOfCharge == 72)
    }

    @Test("Suppresses an out-of-range battery charge reading")
    func suppressesOutOfRangeStateOfCharge() throws {
        let high = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "150", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(high.stateOfCharge == nil)

        let negative = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "-1", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(negative.stateOfCharge == nil)
    }

    @Test("Keeps a battery charge reading at exactly the two-hour edge and suppresses one second past it")
    func appliesInclusiveStateOfChargeAgeLimit() throws {
        let atTheEdge = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-2 * 3600)))
        )
        #expect(atTheEdge.stateOfCharge == 72)

        let oneSecondPast = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-2 * 3600 - 1)))
        )
        #expect(oneSecondPast.stateOfCharge == nil)
    }

    @Test("Decodes the live power values a payload carries, including negative ones")
    func decodesLivePowerValues() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(response.live.solarPower == 1200)
        #expect(response.live.loadPower == 900)
        #expect(response.live.gridPower == 0)
        #expect(response.live.batteryPower == -300)
    }
}
