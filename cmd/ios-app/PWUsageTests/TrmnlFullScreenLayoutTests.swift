import CoreGraphics
@testable import PWUsage
import Testing

@Suite("Trmnl full-screen layout")
struct TrmnlFullScreenLayoutTests {
    private let phoneLandscape = TrmnlFullScreenLayout(
        container: CGSize(width: 874, height: 402), safe: .init(leading: 59, top: 0, trailing: 0, bottom: 21))
    private let phonePortrait = TrmnlFullScreenLayout(
        container: CGSize(width: 402, height: 874), safe: .init(leading: 0, top: 59, trailing: 0, bottom: 34))
    private let wideWindow = TrmnlFullScreenLayout(
        container: CGSize(width: 1600, height: 900), safe: .init(leading: 0, top: 28, trailing: 0, bottom: 0))

    private func controls(_ layout: TrmnlFullScreenLayout) -> [(String, CGRect)] {
        [("close", layout.closeButton), ("previous", layout.previousButton), ("next", layout.nextButton),
         ("position", layout.position)]
    }

    @Test("Nothing sits on the preview in any shape of screen")
    func nothingCoversThePreview() {
        for layout in [phoneLandscape, phonePortrait, wideWindow] {
            for (name, rect) in controls(layout) {
                #expect(!rect.intersects(layout.preview), "\(name) overlaps the preview in \(layout.container)")
            }
        }
    }

    @Test("Every control stays out of the safe areas, and the preview on the display")
    func insideSafeAreas() {
        for layout in [phoneLandscape, phonePortrait, wideWindow] {
            let safeArea = CGRect(
                x: layout.safe.leading, y: layout.safe.top,
                width: layout.container.width - layout.safe.leading - layout.safe.trailing,
                height: layout.container.height - layout.safe.top - layout.safe.bottom)
            for (name, rect) in controls(layout) {
                let tolerant = safeArea.insetBy(dx: -0.5, dy: -0.5)
                #expect(tolerant.contains(rect), "\(name) leaves the safe area in \(layout.container)")
            }
            // The screen itself may run under the home indicator, but not off the display.
            #expect(CGRect(origin: .zero, size: layout.container).contains(layout.preview))
        }
    }

    @Test("Controls do not overlap one another")
    func controlsDoNotOverlap() {
        for layout in [phoneLandscape, phonePortrait, wideWindow] {
            let all = controls(layout)
            for index in all.indices {
                for other in all.indices where other > index {
                    #expect(!all[index].1.intersects(all[other].1), "\(all[index].0) overlaps \(all[other].0)")
                }
            }
        }
    }

    @Test("A landscape view puts the buttons in the bars beside the preview, and the position in a strip under it")
    func landscapeBars() {
        let layout = phoneLandscape
        #expect(layout.isLandscape)
        #expect(layout.previousButton.maxX <= layout.preview.minX)
        #expect(layout.nextButton.minX >= layout.preview.maxX)
        #expect(layout.position.minY >= layout.preview.maxY)
        #expect(layout.position.minX == layout.preview.minX)
        #expect(layout.position.width == layout.preview.width)
        #expect(abs(layout.previousButton.midY - layout.preview.midY) < 0.5)
    }

    @Test("A portrait view puts navigation in the bar below the preview, around the position")
    func portraitBottomBar() {
        let layout = phonePortrait
        #expect(!layout.isLandscape)
        #expect(layout.previousButton.minY >= layout.preview.maxY)
        #expect(layout.nextButton.minY >= layout.preview.maxY)
        #expect(layout.position.minX >= layout.previousButton.maxX)
        #expect(layout.position.maxX <= layout.nextButton.minX)
        #expect(layout.position.width > 100)
    }

    @Test("The preview keeps its 5 by 3 shape and sits centered across the screen")
    func shape() {
        for layout in [phoneLandscape, phonePortrait, wideWindow] {
            let preview = layout.preview
            #expect(abs(preview.width / preview.height - 800.0 / 480.0) < 0.001)
            #expect(abs(preview.midX - layout.container.width / 2) < 0.5)
        }
        #expect(abs(phonePortrait.preview.midY - 437) < 0.5)
    }

    @Test("In landscape the preview gives up some height to the strip, and only that much")
    func landscapeStripCost() {
        let layout = phoneLandscape
        let strip = TrmnlFullScreenLayout.positionStripHeight
        #expect(layout.position.height == strip)
        #expect(layout.position.maxY <= 402 - 21)
        #expect(layout.preview.height > 402 * 0.7)
    }
}
