@testable import PWUsage
import SwiftUI
import Testing
import UIKit

struct EmphasisColorTests {
    private func hex(_ name: String, _ style: UIUserInterfaceStyle) throws -> String {
        let color = try #require(UIColor(named: name))
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: nil)
        return String(format: "%02X%02X%02X", Int((red * 255).rounded()), Int((green * 255).rounded()),
                      Int((blue * 255).rounded()))
    }

    @Test func emphasisIsCeruleanInBothAppearances() throws {
        #expect(try hex("Emphasis", .light) == "0077B6")
        #expect(try hex("Emphasis", .dark) == "4CC2F1")
    }

    @Test func labelsOnEmphasisStayReadableInBothAppearances() throws {
        #expect(try hex("OnEmphasis", .light) == "FFFFFF")
        #expect(try hex("OnEmphasis", .dark) == "00222F")
    }

    @Test func sectionsShareTheEmphasisColor() {
        #expect(SectionTheme.bill.accent == .emphasis)
        #expect(SectionTheme.loadTiming.accent == .emphasis)
    }
}
