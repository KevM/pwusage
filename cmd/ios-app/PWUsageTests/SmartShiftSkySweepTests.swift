import Foundation
@testable import PWUsage
import Testing

@Suite("Smart Shift sky sweep")
struct SmartShiftSkySweepTests {
    @Test("the sweep starts at north and completes a turn every period")
    func sweepBearingCompletesATurnEachPeriod() {
        let period = SmartShiftSkySweep.period
        #expect(SmartShiftSkySweep.bearing(at: 0) == 0)
        #expect(abs(SmartShiftSkySweep.bearing(at: period / 4) - 90) < 0.001)
        #expect(abs(SmartShiftSkySweep.bearing(at: period * 3.5) - 180) < 0.001)
    }

    @Test("a cloud is brightest just as the sweep reaches it")
    func cloudPeaksWhenSwept() {
        let cloud = SmartShiftSkySweep.Cloud(across: 1, down: 0.5, radius: 0.1)
        #expect(abs(cloud.bearing - 90) < 0.001)
        #expect(cloud.opacity(sweepBearing: 90) == SmartShiftSkySweep.peakCloudOpacity)
    }

    @Test("a cloud fades after the sweep passes and is gone before it comes round again")
    func cloudFadesBehindTheSweep() {
        let cloud = SmartShiftSkySweep.Cloud(across: 1, down: 0.5, radius: 0.1)
        let shortlyAfter = cloud.opacity(sweepBearing: 120)
        let later = cloud.opacity(sweepBearing: 200)
        #expect(shortlyAfter < SmartShiftSkySweep.peakCloudOpacity)
        #expect(later < shortlyAfter)
        #expect(cloud.opacity(sweepBearing: 80) == 0)
    }

    @Test("every cloud sits inside the disc")
    func cloudsStayInsideTheDisc() {
        #expect(!SmartShiftSkySweep.clouds.isEmpty)
        for cloud in SmartShiftSkySweep.clouds {
            let offset = hypot(cloud.across - 0.5, cloud.down - 0.5)
            #expect(offset + cloud.radius <= 0.5)
        }
    }
}
