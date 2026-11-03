import SwiftUI

struct DischargeSymbol: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let midY = rect.midY
        let height = rect.height
        let width = rect.width

        // Horizontal stem from leading edge to bar 1
        let bar1X = rect.minX + width * (10.0 / 18.0)
        path.move(to: CGPoint(x: rect.minX, y: midY))
        path.addLine(to: CGPoint(x: bar1X, y: midY))

        // Bar 1 (tallest: full height)
        path.move(to: CGPoint(x: bar1X, y: midY - height * 0.5))
        path.addLine(to: CGPoint(x: bar1X, y: midY + height * 0.5))

        // Bar 2 (medium: 10/18 height)
        let bar2X = rect.minX + width * (14.0 / 18.0)
        path.move(to: CGPoint(x: bar2X, y: midY - height * (5.0 / 18.0)))
        path.addLine(to: CGPoint(x: bar2X, y: midY + height * (5.0 / 18.0)))

        // Bar 3 (shortest: 4/18 height)
        let bar3X = rect.minX + width * (18.0 / 18.0)
        path.move(to: CGPoint(x: bar3X, y: midY - height * (2.0 / 18.0)))
        path.addLine(to: CGPoint(x: bar3X, y: midY + height * (2.0 / 18.0)))

        return path
    }
}
