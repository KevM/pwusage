import Foundation
@testable import PWUsage
import Testing

@Suite("Solar System house from entered faces")
struct SolarSystemHouseManualTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let old = Date(timeIntervalSince1970: 1_450_000_000)
    private let added = Date(timeIntervalSince1970: 1_780_000_000)
    private let detected = SolarLayout(
        planes: [SolarLayoutPlane(azimuth: 200, tilt: 25, dcKwp: 6)],
        acClipKw: nil, confidence: .high, detectedAt: nil)

    private func face(_ panels: Int, _ watts: Double, _ azimuth: Double?, _ tilt: Double?) -> ManualSolarFace {
        ManualSolarFace(label: nil, panelCount: panels, panelWatts: watts, azimuthDegrees: azimuth, tiltDegrees: tilt)
    }

    private func system(_ install: Date?, _ faces: [ManualSolarFace]) -> ManualSolarSystem {
        ManualSolarSystem(label: nil, installDate: install, inverterAcKw: nil, faces: faces)
    }

    private func panelsOnRoof(_ house: SolarSystemHouse) -> Int {
        house.roof.reduce(0) { $0 + $1.panels.count }
    }

    @Test("Each entered face becomes a group with its panel count, size and direction")
    func facesBecomeGroups() {
        let layout = ManualSolarLayout(systems: [system(old, [face(10, 285, 180, 22), face(6, 410, 90, 15)])])
        let groups = layout.houseGroups(detected: detected, on: now)
        #expect(groups.count == 2)
        #expect(groups[0].panelCount == 10)
        #expect(abs(groups[0].kilowatts - 2.85) < 0.0001)
        #expect(groups[0].azimuth == 180)
        #expect(groups[1].panelCount == 6)
        #expect(groups[1].tilt == 15)
    }

    @Test("A face with no direction or tilt takes the largest detected plane's")
    func missingAnglesFallBack() {
        let layout = ManualSolarLayout(systems: [system(old, [face(10, 400, nil, nil)])])
        let group = layout.houseGroups(detected: detected, on: now).first
        #expect(group?.azimuth == 200)
        #expect(group?.tilt == 25)
    }

    @Test("A system not yet installed is left out, and more than three faces are all kept")
    func installDateAndFaceCount() {
        let layout = ManualSolarLayout(systems: [
            system(old, (0 ..< 5).map { face(4, 400, Double($0) * 70, 20) }),
            system(Date(timeIntervalSince1970: 1_800_000_000), [face(8, 400, 180, 20)])
        ])
        #expect(layout.houseGroups(detected: detected, on: now).count == 5)
    }

    @Test("The house shows exactly the entered panel count, not one derived from kilowatts")
    func houseUsesEnteredPanelCount() {
        // 10 panels of 285 W is 2.85 kW, which the 0.4 kW rule alone would draw as 7.
        let layout = ManualSolarLayout(systems: [system(old, [face(10, 285, 180, 22)])])
        let house = SolarSystemHouse(groups: layout.houseGroups(detected: detected, on: now))
        #expect(panelsOnRoof(house) == 10)
    }

    @Test("Changing the panel count or the angle changes the house")
    func editsChangeTheHouse() {
        func house(panels: Int, azimuth: Double) -> SolarSystemHouse {
            let layout = ManualSolarLayout(systems: [system(old, [face(panels, 400, azimuth, 22)])])
            return SolarSystemHouse(groups: layout.houseGroups(detected: detected, on: now))
        }
        #expect(panelsOnRoof(house(panels: 8, azimuth: 180)) != panelsOnRoof(house(panels: 16, azimuth: 180)))
        #expect(house(panels: 8, azimuth: 180).frontAzimuth != house(panels: 8, azimuth: 270).frontAzimuth)
    }

    @Test("A detected group without a panel count still derives it from kilowatts")
    func detectedGroupsUnchanged() {
        let house = SolarSystemHouse(groups: [SolarSystemHouse.Group(azimuth: 180, tilt: 22, kilowatts: 4)])
        #expect(panelsOnRoof(house) == 10)
    }

    @Test("The scene input uses the entered layout and centres the compass on its largest face")
    func sceneInputUsesEnteredLayout() {
        let layout = ManualSolarLayout(systems: [system(old, [face(20, 400, 270, 22), face(4, 400, 90, 22)])])
        let input = SolarSystemSceneInput(
            status: nil, layout: detected, isWaiting: false, manualLayout: layout, now: now)
        #expect(input.groups.count == 2)
        #expect(input.groups.first?.azimuth == 270)
        #expect(input.fittedRange == [270, 270])
        #expect(input.isFound)
    }
}
