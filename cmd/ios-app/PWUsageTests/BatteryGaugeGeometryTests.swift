import CoreGraphics
@testable import PWUsage
import SwiftUI
import Testing
import UIKit

@Suite("Drawn battery gauge geometry")
struct BatteryGaugeGeometryTests {
    private let card = CGSize(width: 360, height: 132)

    private func geometry(_ style: BatteryGaugeStyle = .card, size: CGSize? = nil,
                          charge: Double?, hold: Int?) -> BatteryGaugeGeometry {
        BatteryGaugeGeometry(style: style, size: size ?? card, charge: charge, holdLevel: hold)
    }

    @Test("The card outline is inset 8pt top, bottom and leading, 18pt trailing, with the nub outside it")
    func cardOutline() {
        let gauge = geometry(charge: nil, hold: nil)
        #expect(gauge.body == CGRect(x: 8, y: 8, width: 334, height: 116))
        #expect(gauge.nub.minX > gauge.body.maxX && gauge.nub.maxX <= card.width)
        #expect(abs(gauge.nub.midY - gauge.body.midY) < 0.001)
    }

    @Test("An unknown charge draws no fill; a known one fills from the leading edge in proportion")
    func fill() throws {
        #expect(geometry(charge: nil, hold: 74).fill == nil)
        #expect(geometry(charge: .nan, hold: 74).fill == nil)
        let gauge = geometry(charge: 82, hold: 74)
        let fill = try #require(gauge.fill)
        #expect(fill.minX == gauge.inner.minX)
        #expect(abs(fill.width - gauge.inner.width * 0.82) < 0.001)
        #expect(fill.height == gauge.inner.height)
    }

    @Test("Charges outside 0...100 stay inside the outline")
    func clamped() throws {
        let gauge = geometry(charge: 104.5, hold: nil)
        #expect(try #require(gauge.fill).maxX == gauge.inner.maxX)
        #expect(try #require(geometry(charge: -3, hold: nil).fill).width == 0)
    }

    @Test("The hold line sits at the held level, inside the outline even at 0% and 100%")
    func holdLine() throws {
        let gauge = geometry(charge: 82, hold: 74)
        let line = try #require(gauge.holdLine)
        #expect(abs(line.midX - (gauge.inner.minX + gauge.inner.width * 0.74)) < 0.001)
        #expect(line.minY == gauge.inner.minY && line.maxY == gauge.inner.maxY)
        #expect(geometry(charge: 82, hold: nil).holdLine == nil)
        #expect(try #require(geometry(charge: nil, hold: 100).holdLine).maxX <= gauge.inner.maxX)
        #expect(try #require(geometry(charge: nil, hold: 0).holdLine).minX >= gauge.inner.minX)
    }

    @Test("A hold line near either end stays inside the rounded corners", arguments: [0, 1, 99, 100])
    func holdLineInsideCorners(_ hold: Int) throws {
        for (style, size) in [(BatteryGaugeStyle.card, card), (.bar, CGSize(width: 300, height: 26)),
                              (.mini, CGSize(width: 30, height: 21))] {
            let gauge = geometry(style, size: size, charge: nil, hold: hold)
            let line = try #require(gauge.holdLine)
            let cornerRadius = max(0, gauge.cornerRadius - gauge.lineWidth)
            let inside = Path(roundedRect: gauge.inner, cornerRadius: cornerRadius, style: .circular)
            #expect(inside.contains(CGPoint(x: line.midX, y: line.minY + 0.01)), "\(style) \(hold)% top")
            #expect(inside.contains(CGPoint(x: line.midX, y: line.maxY - 0.01)), "\(style) \(hold)% bottom")
            #expect(line.height >= gauge.inner.height * 0.4 - 0.001)
        }
        let mid = geometry(charge: nil, hold: 50)
        #expect(try #require(mid.holdLine).minY == mid.inner.minY)
    }

    @Test("The mini hold mark is a solid tick inside the outline, within the frame")
    func miniTick() throws {
        let size = CGSize(width: 30, height: 21)
        let gauge = geometry(.mini, size: size, charge: 82, hold: 74)
        let tick = try #require(gauge.holdLine)
        #expect(tick.minY >= gauge.inner.minY && tick.maxY <= gauge.inner.maxY)
        #expect(gauge.nub.maxX <= size.width)
        #expect(BatteryGaugeStyle.mini.dashedHoldLine == false)
        #expect(BatteryGaugeStyle.card.dashedHoldLine && BatteryGaugeStyle.bar.dashedHoldLine)
    }

    @Test("The expanded bar fills its width, leaving room only for the nub")
    func bar() {
        let size = CGSize(width: 300, height: 26)
        let gauge = geometry(.bar, size: size, charge: 50, hold: 74)
        #expect(gauge.body.minX == 0 && gauge.body.height == size.height)
        #expect(gauge.nub.maxX <= size.width && gauge.nub.minX > gauge.body.maxX)
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
