import Foundation
import SwiftUI
import Testing
@testable import PWUsage

struct BillOutlookPresentationTests {
    @Test func dateSelectionDefaultsToLastCompletePointAfterHistoryGap() {
        let first = BillOutlook.point(date: .init(timeIntervalSince1970: 0), buckets: [])
        let last = BillOutlook.point(date: .init(timeIntervalSince1970: 86400), buckets: [])
        #expect(BillOutlookPresentation.selection(in: [first, last], date: nil) == last)
        #expect(BillOutlookPresentation.selection(in: [], date: nil) == nil)
    }
    @Test func deadlineUsesLocalCalendarDaysAcrossDST() throws {
        let formatter = ISO8601DateFormatter()
        let now = try #require(formatter.date(from: "2026-11-01T05:00:00Z"))
        let end = try #require(formatter.date(from: "2026-11-02T06:00:00Z"))
        #expect(BillOutlookPresentation.deadline(now: now, end: end, timeZone: "America/Chicago") == "Cycle ends in 1 day")
        #expect(BillOutlookPresentation.deadline(now: end, end: end, timeZone: "America/Chicago") == nil)
    }
    @Test func aPartialForecastDoesNotClaimToReachCycleEnd() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let title = BillOutlookPresentation.endTitle(projectedEnd: now, cycleEnd: now.addingTimeInterval(86400), timeZone: "UTC")
        #expect(title != "At cycle end")
        #expect(BillOutlookPresentation.endTitle(projectedEnd: now, cycleEnd: now, timeZone: "UTC") == "At cycle end")
    }
}


@MainActor
struct BillOutlookRenderTests {
    @Test func renderChartAtStandardAndAccessibilitySizes() throws {
        let start = Date(timeIntervalSince1970: 1_792_368_000)
        let now = start.addingTimeInterval(20 * 86400)
        let end = start.addingTimeInterval(25 * 86400)
        func point(_ day: Int) -> BillOutlookPoint {
            BillOutlook.point(date: start.addingTimeInterval(Double(day) * 86400), buckets: [
                .init(tariffName: "Home", periodName: "Peak", netGridKwh: Double(day < 20 ? day : 40 - day) * 0.6,
                      buyRate: 0.4, sellRate: 0.04),
                .init(tariffName: "Home", periodName: "Off-Peak", netGridKwh: -Double(day) * 1.2,
                      buyRate: 0.12, sellRate: 0.04)])
        }
        let history = BillOutlookHistory(points: (0...20).map(point), observedThrough: now, complete: true, tariffTimeline: [])
        for large in [false, true] {
            let chart = BillOutlookChart(history: history, projected: (20...25).map(point), cycleStart: start,
                cycleEnd: end, now: now, timeZone: "America/Chicago", currency: "USD")
                .environment(\.dynamicTypeSize, large ? .accessibility2 : .large)
                .environment(\.colorScheme, .light).frame(width: 353).padding(20)
                .background(Color(uiColor: .systemGroupedBackground))
            let renderer = ImageRenderer(content: chart)
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            let data = try #require(image.pngData())
            let directory = URL(fileURLWithPath: "/tmp/pwusage-bill-outlook-renders", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("bill-outlook-\(large ? "large" : "standard").png")
            try data.write(to: url)
            print("Bill outlook render: \(url.path)")
            #expect(image.size.height > 300)
        }
    }
}
