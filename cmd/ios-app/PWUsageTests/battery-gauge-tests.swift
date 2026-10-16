import CoreGraphics
import SwiftUI
import Testing
import UIKit
@testable import PWUsage

@Suite("Drawn battery gauge geometry")
struct BatteryGaugeGeometryTests {
    private let card = CGSize(width: 360, height: 132)

    private func geometry(_ style: BatteryGaugeStyle = .card, size: CGSize? = nil,
                          charge: Double?, hold: Int?) -> BatteryGaugeGeometry {
        BatteryGaugeGeometry(style: style, size: size ?? card, charge: charge, holdLevel: hold)
    }

    @Test("The card outline is inset 8pt top, bottom and leading, 18pt trailing, with the nub outside it")
    func cardOutline() {
        let g = geometry(charge: nil, hold: nil)
        #expect(g.body == CGRect(x: 8, y: 8, width: 334, height: 116))
        #expect(g.nub.minX > g.body.maxX && g.nub.maxX <= card.width)
        #expect(abs(g.nub.midY - g.body.midY) < 0.001)
    }

    @Test("An unknown charge draws no fill; a known one fills from the leading edge in proportion")
    func fill() throws {
        #expect(geometry(charge: nil, hold: 74).fill == nil)
        #expect(geometry(charge: .nan, hold: 74).fill == nil)
        let g = geometry(charge: 82, hold: 74)
        let fill = try #require(g.fill)
        #expect(fill.minX == g.inner.minX)
        #expect(abs(fill.width - g.inner.width * 0.82) < 0.001)
        #expect(fill.height == g.inner.height)
    }

    @Test("Charges outside 0...100 stay inside the outline")
    func clamped() throws {
        let g = geometry(charge: 104.5, hold: nil)
        #expect(try #require(g.fill).maxX == g.inner.maxX)
        #expect(try #require(geometry(charge: -3, hold: nil).fill).width == 0)
    }

    @Test("The hold line sits at the held level, inside the outline even at 0% and 100%")
    func holdLine() throws {
        let g = geometry(charge: 82, hold: 74)
        let line = try #require(g.holdLine)
        #expect(abs(line.midX - (g.inner.minX + g.inner.width * 0.74)) < 0.001)
        #expect(line.minY == g.inner.minY && line.maxY == g.inner.maxY)
        #expect(geometry(charge: 82, hold: nil).holdLine == nil)
        #expect(try #require(geometry(charge: nil, hold: 100).holdLine).maxX <= g.inner.maxX)
        #expect(try #require(geometry(charge: nil, hold: 0).holdLine).minX >= g.inner.minX)
    }

    @Test("The mini hold mark is a tick that pokes out above and below the outline, within the frame")
    func miniTick() throws {
        let size = CGSize(width: 30, height: 21)
        let g = geometry(.mini, size: size, charge: 82, hold: 74)
        let tick = try #require(g.holdLine)
        #expect(tick.minY < g.body.minY && tick.maxY > g.body.maxY)
        #expect(tick.minY >= 0 && tick.maxY <= size.height)
        #expect(g.nub.maxX <= size.width)
        #expect(BatteryGaugeStyle.mini.dashedHoldLine == false)
        #expect(BatteryGaugeStyle.card.dashedHoldLine && BatteryGaugeStyle.bar.dashedHoldLine)
    }

    @Test("The expanded bar fills its width, leaving room only for the nub")
    func bar() {
        let size = CGSize(width: 300, height: 26)
        let g = geometry(.bar, size: size, charge: 50, hold: 74)
        #expect(g.body.minX == 0 && g.body.height == size.height)
        #expect(g.nub.maxX <= size.width && g.nub.minX > g.body.maxX)
    }

    @Test("The pwusage glyph ships as a template image")
    func glyphAsset() throws {
        let image = try #require(UIImage(named: BatteryHoldActivityPresentation.glyphName))
        #expect(image.renderingMode == .alwaysTemplate)
        #expect(image.size == CGSize(width: 24, height: 24))
    }

    @MainActor
    @Test("Renders each gauge style with the glyph, in light and dark", arguments: [ColorScheme.light, .dark])
    func render(_ scheme: ColorScheme) throws {
        let sample = VStack(alignment: .leading, spacing: 12) {
            BatteryGaugeView(style: .card, charge: 82, holdLevel: 74).frame(width: 360, height: 132)
            BatteryGaugeView(style: .card, charge: 82, holdLevel: 74, isStale: true).frame(width: 360, height: 132)
            BatteryGaugeView(style: .card, charge: 71, holdLevel: 74, isFinal: true).frame(width: 360, height: 132)
            BatteryGaugeView(style: .bar, charge: 82, holdLevel: 74).frame(width: 300, height: 26)
            HStack(spacing: 12) {
                Image(BatteryHoldActivityPresentation.glyphName).renderingMode(.template).resizable()
                    .frame(width: 20, height: 20).foregroundStyle(Color.accentColor)
                BatteryGaugeView(style: .mini, charge: 82, holdLevel: 74).frame(width: 30, height: 21)
                BatteryGaugeView(style: .mini, charge: nil, holdLevel: 74).frame(width: 24, height: 17)
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground))
        .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: sample)
        renderer.scale = 3
        let png = try #require(renderer.uiImage?.pngData())
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("battery-gauge-\(scheme).png")
        try png.write(to: output)
        print("Rendered gauge: \(output.path)")
    }
}
