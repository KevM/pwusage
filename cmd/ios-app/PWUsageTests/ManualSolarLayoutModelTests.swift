import Foundation
@testable import PWUsage
import Testing

@Suite("Manual Solar Layout Model")
struct ManualSolarLayoutModelTests {
    private let old = Date(timeIntervalSince1970: 1_450_000_000) // 2015-12
    private let added = Date(timeIntervalSince1970: 1_680_000_000) // 2023-03
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let location = SolarHomeLocation(latitude: 37.77, longitude: -122.41, source: .device)

    // MARK: - Nameplate

    @Test("Two systems with different panel wattages sum to the right nameplate")
    func nameplateSumsAcrossSystems() {
        let layout = ManualSolarLayout(systems: [
            system(old, [face(10, 285, 180, 22), face(4, 285, 270, 22)]),
            system(added, [face(8, 410, 180, 22)])
        ])
        // 14 x 285 W + 8 x 410 W
        #expect(abs(layout.nameplateKw(on: now) - 7.27) < 0.0001)
    }

    @Test("A system counts toward nameplate only from its install date")
    func nameplateStartsAtInstallDate() {
        let layout = ManualSolarLayout(systems: [
            system(old, [face(10, 300, 180, 22)]),
            system(added, [face(10, 400, 180, 22)])
        ])
        let between = Date(timeIntervalSince1970: 1_550_000_000)
        #expect(abs(layout.nameplateKw(on: between) - 3.0) < 0.0001)
        #expect(abs(layout.nameplateKw(on: now) - 7.0) < 0.0001)
    }

    @Test("A system with no install date always counts")
    func undatedSystemAlwaysCounts() {
        let layout = ManualSolarLayout(systems: [system(nil, [face(10, 300, 180, 22)])])
        #expect(abs(layout.nameplateKw(on: .distantPast) - 3.0) < 0.0001)
    }

    // MARK: - Validity

    @Test("Validity needs a system, a face, and sensible numbers")
    func validity() {
        #expect(!ManualSolarLayout(systems: []).isValid)
        #expect(!ManualSolarLayout(systems: [system(old, [])]).isValid)
        #expect(!ManualSolarLayout(systems: [system(old, [face(0, 300, 180, 22)])]).isValid)
        #expect(!ManualSolarLayout(systems: [system(old, [face(5, 0, 180, 22)])]).isValid)
        #expect(!ManualSolarLayout(systems: [system(old, [face(5, 300, 400, 22)])]).isValid)
        #expect(!ManualSolarLayout(systems: [system(old, [face(5, 300, 180, 95)])]).isValid)
        #expect(ManualSolarLayout(systems: [system(old, [face(5, 300, nil, nil)])]).isValid)
        #expect(ManualSolarLayout(systems: [system(old, [face(5, 300, 180, 22)])]).isValid)
    }

    // MARK: - Model

    @Test("Faces pointing the same way in different systems stay separate planes")
    func sameDirectionFacesStaySeparate() throws {
        let layout = ManualSolarLayout(systems: [
            system(old, [face(10, 300, 180, 22)]),
            system(added, [face(10, 400, 180, 22)])
        ])
        let solar = try #require(layout.solarLayout(detected: nil, on: now, detectedAt: nil))
        #expect(solar.planes.count == 2)
        #expect(solar.planes.map(\.dcKwp) == [3.0, 4.0])
        #expect(solar.isManual)
    }

    @Test("Only systems installed by the date become planes")
    func uninstalledSystemsAreLeftOut() throws {
        let layout = ManualSolarLayout(systems: [
            system(old, [face(10, 300, 180, 22)]),
            system(added, [face(10, 400, 180, 22)])
        ])
        let between = Date(timeIntervalSince1970: 1_550_000_000)
        #expect(try #require(layout.solarLayout(detected: nil, on: between, detectedAt: nil)).planes.count == 1)
    }

    @Test("A face with no direction takes the largest detected plane's")
    func missingGeometryFallsBackToDetected() throws {
        let layout = ManualSolarLayout(systems: [system(old, [face(10, 300, nil, nil)])])
        #expect(layout.solarLayout(detected: nil, on: now, detectedAt: nil) == nil)
        let detected = detection(planes: [plane(90, 15, power: 2), plane(200, 30, power: 5)])
        let solar = try #require(layout.solarLayout(detected: detected, on: now, detectedAt: nil))
        #expect(solar.planes.first?.azimuth == 200)
        #expect(solar.planes.first?.tilt == 30)
    }

    @Test("Inverter ratings sum into the clip only when every installed system has one")
    func clipNeedsEveryRating() throws {
        var first = system(old, [face(10, 300, 180, 22)])
        var second = system(added, [face(10, 400, 180, 22)])
        first.inverterAcKw = 5
        second.inverterAcKw = 7.6
        let both = ManualSolarLayout(systems: [first, second])
        let clip = try #require(both.solarLayout(detected: nil, on: now, detectedAt: nil)).acClipKw
        #expect(abs((clip ?? 0) - 12.6) < 0.0001)

        second.inverterAcKw = nil
        let partial = ManualSolarLayout(systems: [first, second])
        #expect(try #require(partial.solarLayout(detected: nil, on: now, detectedAt: nil)).acClipKw == nil)
    }

    @Test("The array model accepts more than three planes from a manual layout")
    func arrayModelAcceptsManyPlanes() throws {
        let faces = (0 ..< 8).map { face(10, 300, Double($0) * 45, 22) }
        let layout = ManualSolarLayout(systems: [system(old, faces)])
        let solar = try #require(layout.solarLayout(detected: nil, on: now, detectedAt: nil))
        #expect(solar.planes.count == 8)
        let noon = Date(timeIntervalSince1970: 1_790_000_000)
        let radiation = OpenMeteoArrayModel.Radiation(ghi: 800, dni: 700, dhi: 100)
        let power = try OpenMeteoArrayModel.powerKw(at: noon, radiation: radiation, layout: solar, location: location)
        #expect(power.isFinite)
    }

    @Test("A detected layout still may not have more than three planes")
    func detectorLayoutsStayAtThree() {
        let planes = (0 ..< 4).map { SolarLayoutPlane(azimuth: Double($0) * 90, tilt: 20, dcKwp: 3) }
        let layout = SolarLayout(planes: planes, acClipKw: nil, confidence: .high, detectedAt: nil)
        let radiation = OpenMeteoArrayModel.Radiation(ghi: 800, dni: 700, dhi: 100)
        #expect(throws: OpenMeteoArrayModel.Error.invalidInput) {
            try OpenMeteoArrayModel.powerKw(at: .now, radiation: radiation, layout: layout, location: location)
        }
        #expect(throws: DecodingError.self) {
            let json = try JSONEncoder().encode(layout)
            _ = try JSONDecoder().decode(SolarLayout.self, from: json)
        }
    }

    // MARK: - Mismatch flags

    @Test("Entered values inside the detected ranges raise no flags")
    func agreementRaisesNothing() {
        let layout = ManualSolarLayout(systems: [system(old, [face(20, 400, 182, 21)])])
        let detected = detection(planes: [plane(180, 22, power: 6.8)])
        #expect(ManualLayoutComparison.flags(manual: layout, detected: detected, on: now).isEmpty)
    }

    @Test("An azimuth more than 5 degrees outside the detected range is flagged")
    func azimuthFlag() {
        // Detected range is 170-190, so 200 is 10 degrees outside and 193 is within the 5 degree allowance.
        let detected = detection(planes: [plane(180, 22, power: 6.8)])
        let far = ManualSolarLayout(systems: [system(old, [face(20, 400, 200, 22)])])
        let flags = ManualLayoutComparison.flags(manual: far, detected: detected, on: now)
        #expect(flags.contains { if case .azimuthOutsideDetectedRange = $0 { true } else { false } })

        let near = ManualSolarLayout(systems: [system(old, [face(20, 400, 193, 22)])])
        #expect(ManualLayoutComparison.flags(manual: near, detected: detected, on: now).isEmpty)
    }

    @Test("An azimuth range that crosses north is compared around the wrap")
    func azimuthFlagAcrossWrap() {
        let detected = detection(planes: [plane(0, 22, power: 6.8, azimuthRange: [350, 10])])
        let inside = ManualSolarLayout(systems: [system(old, [face(20, 400, 358, 22)])])
        #expect(ManualLayoutComparison.flags(manual: inside, detected: detected, on: now).isEmpty)
        let outside = ManualSolarLayout(systems: [system(old, [face(20, 400, 30, 22)])])
        #expect(!ManualLayoutComparison.flags(manual: outside, detected: detected, on: now).isEmpty)
    }

    @Test("A tilt more than 5 degrees outside the detected range is flagged")
    func tiltFlag() {
        // Detected tilt range is 17-27, so 40 is 13 degrees outside.
        let detected = detection(planes: [plane(180, 22, power: 6.8)])
        let steep = ManualSolarLayout(systems: [system(old, [face(20, 400, 180, 40)])])
        let flags = ManualLayoutComparison.flags(manual: steep, detected: detected, on: now)
        #expect(flags.contains { if case .tiltOutsideDetectedRange = $0 { true } else { false } })
    }

    @Test("A different number of directions than detected planes is flagged")
    func directionCountFlag() {
        let detected = detection(planes: [plane(180, 22, power: 3.4), plane(270, 22, power: 3.4)])
        let oneWay = ManualSolarLayout(systems: [system(old, [face(10, 400, 180, 22), face(10, 400, 185, 22)])])
        let flags = ManualLayoutComparison.flags(manual: oneWay, detected: detected, on: now)
        #expect(flags.contains(.directionCountDiffers(entered: 1, detected: 2)))

        let twoWays = ManualSolarLayout(systems: [system(old, [face(10, 400, 180, 22), face(10, 400, 270, 22)])])
        #expect(!ManualLayoutComparison.flags(manual: twoWays, detected: detected, on: now)
            .contains { if case .directionCountDiffers = $0 { true } else { false } })
    }

    @Test("Fitted capacity outside 60 to 90 percent of nameplate is flagged")
    func capacityFlag() {
        let layout = ManualSolarLayout(systems: [system(old, [face(20, 400, 180, 22)])]) // 8 kW
        for fitted in [4.0, 7.5] { // 50% is low, 94% is high
            let detected = detection(planes: [plane(180, 22, power: fitted)])
            let flags = ManualLayoutComparison.flags(manual: layout, detected: detected, on: now)
            #expect(flags.contains(.capacityOutsideBand(fittedKw: fitted, nameplateKw: 8)))
        }
        let healthy = detection(planes: [plane(180, 22, power: 6.8)]) // 85%
        #expect(ManualLayoutComparison.flags(manual: layout, detected: healthy, on: now).isEmpty)
    }

    @Test("Nothing is compared without a detected layout")
    func noDetectionNoFlags() {
        let layout = ManualSolarLayout(systems: [system(old, [face(20, 400, 200, 40)])])
        #expect(ManualLayoutComparison.flags(manual: layout, detected: nil, on: now).isEmpty)
        let failed = DetectedSolarLayout(
            status: .failed, confidence: nil, reasons: [], planes: [], acClipKw: nil,
            historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
        #expect(ManualLayoutComparison.flags(manual: layout, detected: failed, on: now).isEmpty)
    }

    // MARK: - Fixtures

    private func face(_ panels: Int, _ watts: Double, _ azimuth: Double?, _ tilt: Double?) -> ManualSolarFace {
        ManualSolarFace(label: nil, panelCount: panels, panelWatts: watts, azimuthDegrees: azimuth, tiltDegrees: tilt)
    }

    private func system(_ install: Date?, _ faces: [ManualSolarFace]) -> ManualSolarSystem {
        ManualSolarSystem(label: nil, installDate: install, inverterAcKw: nil, faces: faces)
    }

    /// A detected plane whose 90% ranges are 10 degrees of azimuth and tilt either side.
    private func plane(
        _ azimuth: Double, _ tilt: Double, power: Double, azimuthRange: [Double]? = nil
    ) -> DetectedSolarLayout.Plane {
        DetectedSolarLayout.Plane(
            azimuth: azimuth, tilt: tilt, dcKwp: power / 0.85, effectiveKw: power,
            azimuthRange90: azimuthRange ?? [azimuth - 10, azimuth + 10], tiltRange90: [tilt - 5, tilt + 5])
    }

    private func detection(planes: [DetectedSolarLayout.Plane]) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [], planes: planes, acClipKw: nil,
            historyDays: 365, clearDays: 80, firstDay: nil, lastDay: nil)
    }
}
