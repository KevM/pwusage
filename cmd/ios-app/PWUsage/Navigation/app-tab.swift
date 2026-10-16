import Foundation

/// The app's top-level areas. Kept free of SwiftUI so another platform's root
/// view can reuse the same identities, titles and symbols.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case home
    case bill
    case smartShift
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .bill: "Bill"
        case .smartShift: "Smart Shift"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .home: "house"
        case .bill: "receipt"
        case .smartShift: "bolt.badge.clock"
        case .settings: "gearshape"
        }
    }
}
