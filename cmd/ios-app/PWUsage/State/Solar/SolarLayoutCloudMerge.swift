import Foundation

enum SolarLayoutCloudMerge {
    static func merge(local: SolarLayoutRecord?, remote: SolarLayoutRecord) -> SolarLayoutRecord {
        let winningLoc = winningLocation(local: local, remote: remote)
        let localCand = validateResult(candidate(for: local), for: winningLoc.location)
        let remoteCand = validateResult(candidate(for: remote), for: winningLoc.location)
        let validated = winningCandidate(local: localCand, remote: remoteCand)
        return SolarLayoutRecord(
            location: winningLoc.location,
            locationSetAt: winningLoc.locationSetAt,
            result: validated?.result,
            detectedAt: validated?.detectedAt,
            attemptedAt: validated?.attemptedAt,
            detectorVersion: validated?.detectorVersion,
            resultLocation: validated?.resultLocation
        )
    }

    private static func winningLocation(
        local: SolarLayoutRecord?, remote: SolarLayoutRecord
    ) -> (location: SolarHomeLocation?, locationSetAt: Date?) {
        let localLoc = local?.location?.rounded
        let localDate = local?.locationSetAt
        let remoteLoc = remote.location?.rounded
        let remoteDate = remote.locationSetAt

        guard let localLoc else { return (remoteLoc, remoteDate) }
        guard let remoteLoc else { return (localLoc, localDate) }

        if let remoteDate, let localDate {
            return remoteDate > localDate ? (remoteLoc, remoteDate) : (localLoc, localDate)
        }
        return remoteDate != nil ? (remoteLoc, remoteDate) : (localLoc, localDate)
    }

    private struct ResultCandidate {
        let result: DetectedSolarLayout
        let detectedAt: Date?
        let attemptedAt: Date?
        let detectorVersion: Int?
        let resultLocation: SolarHomeLocation?
    }

    private static func candidate(for record: SolarLayoutRecord?) -> ResultCandidate? {
        guard let record, let result = record.result else { return nil }
        return ResultCandidate(
            result: result,
            detectedAt: record.detectedAt,
            attemptedAt: record.attemptedAt,
            detectorVersion: record.detectorVersion,
            resultLocation: record.resultLocation?.rounded
        )
    }

    private static func validateResult(
        _ candidate: ResultCandidate?, for location: SolarHomeLocation?
    ) -> ResultCandidate? {
        guard let candidate,
              let location,
              solarLocationsShareCoordinates(candidate.resultLocation, location) else {
            return nil
        }
        return candidate
    }

    private static func winningCandidate(
        local: ResultCandidate?, remote: ResultCandidate?
    ) -> ResultCandidate? {
        guard let local else { return remote }
        guard let remote else { return local }

        let localV = local.detectorVersion ?? 0
        let remoteV = remote.detectorVersion ?? 0
        if remoteV > localV { return remote }
        if localV > remoteV { return local }

        if let rAttempt = remote.attemptedAt, let lAttempt = local.attemptedAt {
            return rAttempt > lAttempt ? remote : local
        }
        return remote.attemptedAt != nil ? remote : local
    }
}
