import SwiftUI

/// One side of the standard broken-bar mark: a rectangle whose cut edge rises to the right, so the
/// two pieces of a bar leave a parallel diagonal gap between them.
struct SmartShiftBarCut: Shape {
    enum Edge { case top, bottom }

    let edge: Edge

    func path(in rect: CGRect) -> Path {
        let slant = SmartShiftBarGeometry.cutSlant
        var path = Path()
        switch edge {
        case .top:
            path.move(to: CGPoint(x: rect.minX, y: rect.minY + slant))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        case .bottom:
            path.move(to: CGPoint(x: rect.minX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - slant))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        }
        path.closeSubpath()
        return path
    }
}
