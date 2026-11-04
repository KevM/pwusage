import SwiftUI

/// SwiftUI on iOS 18 has no callback for a swipe-down on a sheet whose dismissal
/// is disabled, so this listens on UIKit's presentation delegate. SwiftUI relies
/// on that delegate for its own sheet bookkeeping, so the proxy forwards every
/// other message to the delegate it replaced.
struct SheetDismissAttemptObserver: UIViewControllerRepresentable {
    let onAttempt: () -> Void

    func makeUIViewController(context: Context) -> Controller { Controller() }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.onAttempt = onAttempt
    }

    final class Controller: UIViewController {
        var onAttempt: () -> Void = {}
        /// The presentation controller holds its delegate weakly, so the proxy
        /// lives here for as long as the sheet does.
        var proxy: Proxy?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard proxy == nil, let presentation = presentationController else { return }
            let proxy = Proxy(original: presentation.delegate) { [weak self] in self?.onAttempt() }
            presentation.delegate = proxy
            self.proxy = proxy
        }
    }

    final class Proxy: NSObject, UIAdaptivePresentationControllerDelegate {
        nonisolated(unsafe) private weak var original: (any UIAdaptivePresentationControllerDelegate)?
        let onAttempt: () -> Void

        init(original: (any UIAdaptivePresentationControllerDelegate)?, onAttempt: @escaping () -> Void) {
            self.original = original
            self.onAttempt = onAttempt
        }

        func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
            onAttempt()
            original?.presentationControllerDidAttemptToDismiss?(presentationController)
        }

        override func responds(to aSelector: Selector!) -> Bool {
            super.responds(to: aSelector) || original?.responds(to: aSelector) == true
        }

        override func forwardingTarget(for aSelector: Selector!) -> Any? {
            original?.responds(to: aSelector) == true ? original : super.forwardingTarget(for: aSelector)
        }
    }
}
