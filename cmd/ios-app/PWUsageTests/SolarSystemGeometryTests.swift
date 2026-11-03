import CoreGraphics
import Foundation
@testable import PWUsage
import Testing

@Suite("Solar System geometry")
struct SolarSystemGeometryTests {
    private static func days(from start: String, count: Int) -> [String] {
        (0 ..< count).compactMap { SiteLocalDays.adding($0, to: start, timeZone: .gmt) }
    }

    // MARK: - Strip

    @Test func weeksAreColumnsAndWeekdaysAreRows() throws {
        // 2026-11-01 is a Sunday.
        let layout = SolarSystemStripLayout(days: Self.days(from: "2026-10-25", count: 14), width: 400)
        #expect(layout.columns == 2)
        #expect(layout.bands == 1)
        let sunday = try #require(layout.cells.first { $0.day == "2026-11-01" })
        #expect(sunday.row == 0)
        #expect(sunday.column == 1)
        let saturday = try #require(layout.cells.first { $0.day == "2026-10-31" })
        #expect(saturday.row == 6)
        #expect(saturday.column == 0)
    }

    @Test func onlyStoredDaysGetCells() {
        let layout = SolarSystemStripLayout(days: ["2026-11-01", "2026-11-04"], width: 400)
        #expect(layout.cells.map(\.day) == ["2026-11-01", "2026-11-04"])
        #expect(SolarSystemStripLayout(days: [], width: 400).cells.isEmpty)
    }

    @Test func theStripStaysCenteredAsOlderWeeksArrive() throws {
        let one = SolarSystemStripLayout(days: Self.days(from: "2026-11-01", count: 7), width: 300)
        let three = SolarSystemStripLayout(days: Self.days(from: "2026-10-18", count: 21), width: 300)
        for layout in [one, three] {
            let frames = layout.cells.map(layout.frame)
            let left = try #require(frames.map(\.minX).min())
            let right = try #require(frames.map(\.maxX).max())
            #expect(abs((left - 0) - (300 - right - layout.pitch + layout.cellSize)) < 0.001)
        }
        // The newest week stays rightmost.
        let newest = try #require(three.cells.last)
        #expect(newest.column == three.columns - 1)
    }

    @Test func narrowWidthsWrapIntoTwoBandsWithTheNewestLast() throws {
        let year = Self.days(from: "2025-11-02", count: 365)
        let wide = SolarSystemStripLayout(days: year, width: 900)
        #expect(wide.bands == 1)
        let narrow = SolarSystemStripLayout(days: year, width: 340)
        #expect(narrow.bands == 2)
        #expect(narrow.columnsPerBand == (narrow.columns + 1) / 2)
        let last = try #require(narrow.cells.last)
        #expect(last.band == 1)
        #expect(last.column == narrow.columnsPerBand - 1)
        for cell in narrow.cells {
            let frame = narrow.frame(cell)
            #expect(frame.minX >= -0.001)
            #expect(frame.maxX <= 340.001)
        }
    }

    @Test func monthsAndYearsSitOnTheirOwnLinesWithoutOverlapping() throws {
        let partial = SolarSystemStripLayout(days: Self.days(from: "2026-10-05", count: 20), width: 400)
        #expect(!partial.labels.contains { $0.kind == .month })

        let span = SolarSystemStripLayout(days: Self.days(from: "2025-11-15", count: 120), width: 900)
        // January gets its month and, on the line above, its year.
        let january = try #require(span.cells.first { $0.day == "2026-01-01" })
        #expect(span.labels.contains { $0.kind == .month && $0.column == january.column })
        #expect(span.labels.contains { $0.kind == .year && $0.text == "2026" && $0.column == january.column })
        let month = try #require(span.labels.first { $0.kind == .month })
        let year = try #require(span.labels.first { $0.kind == .year })
        #expect(span.labelOrigin(year).y < span.labelOrigin(month).y)
        for (index, label) in span.labels.enumerated() {
            for other in span.labels[(index + 1)...] where other.band == label.band && other.kind == label.kind {
                #expect(!Self.span(label).overlaps(Self.span(other)), "\(label.text) overlaps \(other.text)")
            }
        }
        // The newest end carries its year, ending at the newest column.
        let recent = SolarSystemStripLayout(days: Self.days(from: "2026-09-20", count: 40), width: 400)
        let newest = try #require(recent.labels.first { $0.trailing })
        #expect(newest.text == "2026")
        #expect(newest.column == recent.columns - 1)
    }

    private static func span(_ label: SolarSystemStripLayout.Label) -> Range<Int> {
        let width = label.kind == .year ? SolarSystemStripLayout.yearLabelColumns
            : SolarSystemStripLayout.monthLabelColumns
        return label.trailing ? label.column - width + 1 ..< label.column + 1 : label.column ..< label.column + width
    }

    @Test func aWideningStripKeepsTheNewestWeekAnchoredAroundTheCenter() throws {
        let layout = SolarSystemStripLayout(days: Self.days(from: "2026-10-18", count: 21), width: 300)
        let newest = try #require(layout.cells.last)
        let settled = layout.frame(newest).midX
        let halfway = layout.widening(to: Double(layout.columns) - 0.5).frame(newest).midX
        #expect(abs((settled - halfway) - layout.pitch / 4) < 0.001)
    }

    @Test func aTapFindsItsDay() throws {
        let layout = SolarSystemStripLayout(days: Self.days(from: "2026-10-25", count: 14), width: 400)
        let cell = try #require(layout.cells.first { $0.day == "2026-11-04" })
        let frame = layout.frame(cell)
        #expect(layout.cell(at: CGPoint(x: frame.midX, y: frame.midY))?.day == "2026-11-04")
        #expect(layout.cell(at: CGPoint(x: -50, y: -50)) == nil)
    }

    // MARK: - Wedge

    @Test func theStylizedWedgeNarrowsWithClearDaysThenUsesTheFit() {
        let widths = [0, 5, 15, 40, 120].map { SolarSystemWedge.width(clearDays: $0, fittedRange: nil) }
        #expect(widths[0] == 164)
        #expect(zip(widths, widths.dropFirst()).allSatisfy { $0 > $1 })
        #expect(widths.allSatisfy { $0 > 4 })
        #expect(SolarSystemWedge.bannerWidth(clearDays: 0, fittedRange: nil) == 156)
        #expect(SolarSystemWedge.bannerWidth(clearDays: 20, fittedRange: nil)
            < SolarSystemWedge.width(clearDays: 20, fittedRange: nil))
        #expect(SolarSystemWedge.width(clearDays: 3, fittedRange: [170, 200]) == 30)
        #expect(SolarSystemWedge.width(clearDays: 3, fittedRange: [350, 10]) == 20)
        #expect(SolarSystemWedge.width(clearDays: 3, fittedRange: [180, 180]) == SolarSystemWedge.minimumWidth)
        #expect(SolarSystemWedge.center(fittedRange: [350, 10], latitude: 40) == 0)
        #expect(SolarSystemWedge.center(fittedRange: nil, latitude: 40) == 180)
        #expect(SolarSystemWedge.center(fittedRange: nil, latitude: -33) == 0)
    }

    // MARK: - House

    @Test func theLargestGroupTakesTheFrontAndOthersTheNearestFace() {
        let assigned = SolarSystemHouse.assign(
            [.init(azimuth: 95, tilt: 20, kilowatts: 2), .init(azimuth: 190, tilt: 22, kilowatts: 6),
             .init(azimuth: 280, tilt: 20, kilowatts: 1.5)],
            frontAzimuth: 190)
        #expect(assigned[.front]?.first?.kilowatts == 6)
        // Front 190: right 280, back 10, left 100.
        #expect(assigned[.left]?.first?.azimuth == 95)
        #expect(assigned[.right]?.first?.azimuth == 280)
        #expect(assigned[.back] == nil)
    }

    @Test func panelCountIsSizeOverFourHundredWatts() {
        #expect(SolarSystemHouse.panelCount(kilowatts: 8.8) == 22)
        #expect(SolarSystemHouse.panelCount(kilowatts: 0.1) == 1)
        #expect(SolarSystemHouse.panelCount(kilowatts: 0) == 0)
    }

    @Test func theFootprintScalesWithKwWithinLimits() {
        let small = SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 20, kilowatts: 2)])
        let large = SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 20, kilowatts: 12)])
        let huge = SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 20, kilowatts: 60)])
        #expect(small.length < large.length)
        #expect(abs(huge.length - 12 * 1.3) < 1e-9)
        #expect(abs(small.length - 12 * 0.72) < 1e-9)
        #expect(abs(SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 20, kilowatts: 9)]).depth - 8) < 1e-9)
    }

    @Test func theFrontFaceLooksTowardTheLargestGroupAndPitchIsItsTilt() throws {
        let house = SolarSystemHouse(groups: [.init(azimuth: 135, tilt: 30, kilowatts: 6)])
        #expect(house.pitchDegrees == 30)
        let front = try #require(house.roof.first { $0.side == .front })
        // The normal's horizontal part points southeast.
        let heading = atan2(front.normal.x, front.normal.y) * 180 / .pi
        #expect(abs(heading - 135) < 0.5)
        let tilt = acos(front.normal.z) * 180 / .pi
        #expect(abs(tilt - 30) < 0.5)
        #expect(house.roof.allSatisfy { $0.normal.z > 0 })
        #expect(house.walls.allSatisfy { abs($0.normal.z) < 1e-9 })
    }

    @Test(arguments: [2.0, 8.8, 14.0, 24.0])
    func panelsFitInsideTheirFace(kilowatts: Double) throws {
        let house = SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 25, kilowatts: kilowatts),
                                              .init(azimuth: 270, tilt: 25, kilowatts: kilowatts / 3)])
        let front = try #require(house.roof.first { $0.side == .front })
        #expect(front.panels.count == SolarSystemHouse.panelCount(kilowatts: kilowatts))
        let right = try #require(house.roof.first { $0.side == .right })
        #expect(right.panels.count == SolarSystemHouse.panelCount(kilowatts: kilowatts / 3))
        for face in [front, right] {
            for panel in face.panels {
                for corner in panel {
                    #expect(Self.liesOn(corner, face: face), "\(face.side) corner \(corner) off the face")
                }
            }
        }
    }

    /// On the face's plane (within the lift above it) and inside its polygon.
    private static func liesOn(_ point: SIMD3<Double>, face: SolarSystemHouse.Face) -> Bool {
        let offset = point - face.corners[0]
        let height = (offset * face.normal).sum()
        guard height > -1e-6, height < 0.1 else { return false }
        let count = face.corners.count
        return (0 ..< count).allSatisfy { index in
            let start = face.corners[index]
            let edge = face.corners[(index + 1) % count] - start
            let toPoint = point - start
            let crossed = SIMD3(
                edge.y * toPoint.z - edge.z * toPoint.y, edge.z * toPoint.x - edge.x * toPoint.z,
                edge.x * toPoint.y - edge.y * toPoint.x)
            return (crossed * face.normal).sum() <= 1e-6
        }
    }

    // MARK: - Projection

    @Test func projectsOrthographicallyFromYawAndElevation() {
        let south = SolarSystemCamera(yaw: 180, elevation: 0)
        #expect(abs(south.project([1, 0, 0]).x - 1) < 1e-9)
        #expect(abs(south.project([0, 0, 1]).y - 1) < 1e-9)
        #expect(abs(south.project([0, 5, 0]).x) < 1e-9)
        let east = SolarSystemCamera(yaw: 90, elevation: 0)
        #expect(abs(east.project([0, 1, 0]).x - 1) < 1e-9)
        let above = SolarSystemCamera(yaw: 180, elevation: 90)
        #expect(abs(above.project([0, 1, 0]).y - 1) < 1e-9)
    }

    @Test func onlyFacesTowardTheCameraAreVisible() {
        let south = SolarSystemCamera(yaw: 180, elevation: 30)
        #expect(south.sees([0, -1, 0]))
        #expect(!south.sees([0, 1, 0]))
        #expect(south.sees([0, 0, 1]))
        // The back slope shows only when the camera is higher than the roof pitch.
        let house = SolarSystemHouse(groups: [.init(azimuth: 180, tilt: 25, kilowatts: 6)])
        let low = SolarSystemCamera(yaw: 180, elevation: 15)
        #expect(house.roof.filter { low.sees($0.normal) }.map(\.side) == [.front, .right, .left])
        #expect(house.roof.filter { south.sees($0.normal) }.map(\.side).contains(.back))
        #expect(house.walls.filter { low.sees($0.normal) }.map(\.side) == [.front])
    }

    @Test func draggingTurnsAndClampsTheElevation() {
        let camera = SolarSystemCamera(yaw: 350, elevation: 30).dragged(yawBy: 20, elevationBy: 100)
        #expect(abs(camera.yaw - 10) < 1e-9)
        #expect(camera.elevation == SolarSystemCamera.elevationRange.upperBound)
        #expect(SolarSystemCamera(yaw: 0, elevation: 30).dragged(yawBy: 0, elevationBy: -100).elevation
            == SolarSystemCamera.elevationRange.lowerBound)
    }
}
