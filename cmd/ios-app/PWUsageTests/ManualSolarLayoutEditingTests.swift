import Foundation
@testable import PWUsage
import Testing

@Suite("Manual Solar Layout Editing")
struct ManualSolarLayoutEditingTests {
    /// Planes as (azimuth, tilt) pairs with a size that falls with their position, largest first.
    private func detected(_ planes: [[Double]]) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [],
            planes: planes.enumerated().map { index, pair in
                let power = Double(planes.count - index)
                return DetectedSolarLayout.Plane(
                    azimuth: pair[0], tilt: pair[1], dcKwp: power, effectiveKw: power * 0.85,
                    azimuthRange90: [pair[0] - 5, pair[0] + 5], tiltRange90: [pair[1] - 3, pair[1] + 3])
            },
            acClipKw: nil, historyDays: 365, clearDays: 80, firstDay: nil, lastDay: nil)
    }

    @Test("A starting layout has one system with one face prefilled from the largest detected plane")
    func startingLayoutUsesLargestPlane() throws {
        let layout = ManualSolarLayout.starting(detected: detected([[200, 30], [90, 15]]))
        let face = try #require(layout.systems.first?.faces.first)
        #expect(layout.systems.count == 1)
        #expect(face.azimuthDegrees == 200)
        #expect(face.tiltDegrees == 30)
        #expect(face.panelCount > 0)
        #expect(face.panelWatts > 0)
    }

    @Test("A starting layout with nothing detected leaves direction and tilt empty")
    func startingLayoutWithoutDetection() throws {
        let face = try #require(ManualSolarLayout.starting(detected: nil).systems.first?.faces.first)
        #expect(face.azimuthDegrees == nil)
        #expect(face.tiltDegrees == nil)
    }

    @Test("A new face copies the wattage of the system's other faces and takes the next detected plane")
    func newFaceCopiesWattageAndTakesNextPlane() throws {
        var system = ManualSolarSystem(
            label: nil, installDate: nil, inverterAcKw: nil,
            faces: [ManualSolarFace(
                label: nil, panelCount: 10, panelWatts: 285, azimuthDegrees: 200, tiltDegrees: 30)])
        system.addFace(detected: detected([[200, 30], [90, 15]]))
        let added = try #require(system.faces.last)
        #expect(system.faces.count == 2)
        #expect(added.panelWatts == 285)
        // Planes are taken largest first, so the second face gets the smaller plane.
        #expect(added.azimuthDegrees == 90)
        #expect(added.tiltDegrees == 15)
    }

    @Test("A new face past the detected planes has no direction")
    func newFacePastDetectedPlanes() throws {
        var system = ManualSolarSystem(label: nil, installDate: nil, inverterAcKw: nil, faces: [])
        let one = detected([[180, 22]])
        system.addFace(detected: one)
        system.addFace(detected: one)
        let second = try #require(system.faces.last)
        #expect(second.azimuthDegrees == nil)
        #expect(second.tiltDegrees == nil)
    }

    @Test("Normalizing keeps install dates to the start of their month and drops blank labels")
    func normalizing() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let midMonth = try #require(calendar.date(from: DateComponents(year: 2023, month: 3, day: 17, hour: 9)))
        let startOfMonth = try #require(calendar.date(from: DateComponents(year: 2023, month: 3, day: 1)))
        let layout = ManualSolarLayout(systems: [
            ManualSolarSystem(
                label: "  ", installDate: midMonth, inverterAcKw: nil,
                faces: [ManualSolarFace(
                    label: " South ", panelCount: 4, panelWatts: 400, azimuthDegrees: nil, tiltDegrees: nil)])
        ])
        let normalized = layout.normalized(calendar: calendar)
        #expect(normalized.systems.first?.installDate == startOfMonth)
        #expect(normalized.systems.first?.label == nil)
        #expect(normalized.systems.first?.faces.first?.label == "South")
    }
}
