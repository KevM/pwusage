import SwiftUI

/// Scrolls the `ScrollView` inside `content` to the view with `.id(target)` once, the first time a
/// target is known.
struct RatePlanScrollReader<Content: View>: View {
    let target: Int?
    @ViewBuilder let content: () -> Content
    @State private var didScroll = false

    var body: some View {
        ScrollViewReader { proxy in
            content()
                .task(id: target) {
                    guard !didScroll, let target else { return }
                    didScroll = true
                    proxy.scrollTo(target, anchor: .top)
                }
        }
    }
}
