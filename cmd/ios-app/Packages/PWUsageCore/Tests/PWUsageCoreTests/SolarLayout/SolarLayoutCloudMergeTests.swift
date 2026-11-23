import Foundation
@testable import PWUsageCore
import Testing

@Suite("Solar Layout Cloud Merge")
struct SolarLayoutCloudMergeTests {
    private let locA = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)
    private let locB = SolarHomeLocation(latitude: 40.71, longitude: -74.00, source: .device)

    @Test("Nil local takes remote directly when result matches location")
    func nilLocalTakesRemote() {
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.locationSetAt == date)
        #expect(merged.result?.status == .detected)
        #expect(merged.detectorVersion == 1)
        #expect(merged.resultLocation == locA)
    }

    @Test("Nil local drops remote result when result location does not match")
    func nilLocalDropsMismatchedRemoteResult() {
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: locB
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.locationSetAt == date)
        #expect(merged.result == nil)
        #expect(merged.resultLocation == nil)
    }

    @Test("Newer locationSetAt wins")
    func newerLocationSetAtWins() {
        let oldDate = Date(timeIntervalSince1970: 100)
        let newDate = Date(timeIntervalSince1970: 200)

        let localOld = SolarLayoutRecord(location: locA, locationSetAt: oldDate)
        let remoteNew = SolarLayoutRecord(location: locB, locationSetAt: newDate)
        let mergedRemoteWins = SolarLayoutCloudMerge.merge(local: localOld, remote: remoteNew)
        #expect(mergedRemoteWins.location == locB)
        #expect(mergedRemoteWins.locationSetAt == newDate)

        let localNew = SolarLayoutRecord(location: locA, locationSetAt: newDate)
        let remoteOld = SolarLayoutRecord(location: locB, locationSetAt: oldDate)
        let mergedLocalWins = SolarLayoutCloudMerge.merge(local: localNew, remote: remoteOld)
        #expect(mergedLocalWins.location == locA)
        #expect(mergedLocalWins.locationSetAt == newDate)
    }

    @Test("Remote result for old location is dropped")
    func remoteResultForOldLocationDropped() {
        let oldDate = Date(timeIntervalSince1970: 100)
        let newDate = Date(timeIntervalSince1970: 200)

        let localNew = SolarLayoutRecord(location: locB, locationSetAt: newDate)
        let remoteOld = SolarLayoutRecord(
            location: locA,
            locationSetAt: oldDate,
            result: makeResult(.detected),
            detectedAt: oldDate,
            attemptedAt: oldDate,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localNew, remote: remoteOld)
        #expect(merged.location == locB)
        #expect(merged.result == nil)
        #expect(merged.resultLocation == nil)
    }

    @Test("Valid local result for winning location is retained over newer remote result for obsolete location")
    func validLocalResultRetainedOverNewerObsoleteRemoteResult() {
        let tOld = Date(timeIntervalSince1970: 50)
        let t100 = Date(timeIntervalSince1970: 100)
        let t110 = Date(timeIntervalSince1970: 110)

        let local = SolarLayoutRecord(
            location: locB,
            locationSetAt: t100,
            result: makeResult(.detected),
            detectedAt: t100,
            attemptedAt: t100,
            detectorVersion: 1,
            resultLocation: locB
        )
        let remote = SolarLayoutRecord(
            location: locA,
            locationSetAt: tOld,
            result: makeResult(.detected),
            detectedAt: t110,
            attemptedAt: t110,
            detectorVersion: 2,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        #expect(merged.location == locB)
        #expect(merged.locationSetAt == t100)
        #expect(merged.result?.status == .detected)
        #expect(merged.detectorVersion == 1)
        #expect(merged.attemptedAt == t100)
        #expect(merged.resultLocation == locB)
    }

    @Test("Local result kept if location unchanged")
    func localResultKeptIfLocationUnchanged() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let local = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remote = SolarLayoutRecord(location: locA, locationSetAt: date2)
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        #expect(merged.location == locA)
        #expect(merged.result?.status == .detected)
        #expect(merged.resultLocation == locA)
    }

    @Test("Higher detectorVersion wins")
    func higherDetectorVersionWins() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let localV1 = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date2,
            attemptedAt: date2,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remoteV2 = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.lowConfidence),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 2,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localV1, remote: remoteV2)
        #expect(merged.detectorVersion == 2)
        #expect(merged.result?.status == .lowConfidence)
    }

    @Test("Newer attemptedAt wins when detectorVersion is equal")
    func newerAttemptedAtWins() {
        let date1 = Date(timeIntervalSince1970: 100)
        let date2 = Date(timeIntervalSince1970: 200)

        let localOld = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.notEnoughHistory),
            detectedAt: date1,
            attemptedAt: date1,
            detectorVersion: 1,
            resultLocation: locA
        )
        let remoteNew = SolarLayoutRecord(
            location: locA,
            locationSetAt: date1,
            result: makeResult(.detected),
            detectedAt: date2,
            attemptedAt: date2,
            detectorVersion: 1,
            resultLocation: locA
        )
        let merged = SolarLayoutCloudMerge.merge(local: localOld, remote: remoteNew)
        #expect(merged.result?.status == .detected)
        #expect(merged.attemptedAt == date2)
    }

    @Test("Coordinate rounding verified")
    func coordinateRoundingVerified() {
        let unrounded = SolarHomeLocation(latitude: 37.12345, longitude: -122.56789, source: .device)
        let date = Date(timeIntervalSince1970: 100)
        let remote = SolarLayoutRecord(
            location: unrounded,
            locationSetAt: date,
            result: makeResult(.detected),
            detectedAt: date,
            attemptedAt: date,
            detectorVersion: 1,
            resultLocation: unrounded
        )
        let merged = SolarLayoutCloudMerge.merge(local: nil, remote: remote)
        #expect(merged.location?.latitude == 37.12)
        #expect(merged.location?.longitude == -122.57)
        #expect(merged.resultLocation?.latitude == 37.12)
        #expect(merged.resultLocation?.longitude == -122.57)
    }

    private func makeResult(_ status: DetectedSolarLayout.Status) -> DetectedSolarLayout {
        let plane = DetectedSolarLayout.Plane(
            azimuth: 180, tilt: 30, dcKwp: 5, effectiveKw: 4.25,
            azimuthRange90: [175, 185], tiltRange90: [25, 35]
        )
        return DetectedSolarLayout(
            status: status, confidence: status == .detected ? "high" : nil,
            reasons: [], planes: status == .detected ? [plane] : [], acClipKw: nil,
            historyDays: 90, clearDays: 30, firstDay: nil, lastDay: nil
        )
    }
}
