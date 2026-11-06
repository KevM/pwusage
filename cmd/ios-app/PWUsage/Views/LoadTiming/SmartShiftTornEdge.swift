import SwiftUI

/// A rectangle with one zigzag edge, for the cut in a torn bar.
struct SmartShiftTornEdge: Shape {
    enum Edge { case top, bottom }

    let edge: Edge
    private let toothWidth: CGFloat = 10
    private let toothDepth: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let solidY = edge == .top ? rect.maxY : rect.minY
        let tornY = edge == .top ? rect.minY : rect.maxY
        let inward: CGFloat = edge == .top ? toothDepth : -toothDepth
        path.move(to: CGPoint(x: rect.minX, y: solidY))
        path.addLine(to: CGPoint(x: rect.minX, y: tornY))
        let teeth = max(Int((rect.width / toothWidth).rounded()), 1)
        let step = rect.width / CGFloat(teeth * 2)
        for index in 1 ... (teeth * 2) {
            let isInward = !index.isMultiple(of: 2)
            path.addLine(to: CGPoint(x: rect.minX + CGFloat(index) * step, y: isInward ? tornY + inward : tornY))
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: solidY))
        path.closeSubpath()
        return path
    }
}
