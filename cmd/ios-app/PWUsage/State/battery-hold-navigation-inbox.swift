import Combine
import Foundation

/// A mailbox handles intents arriving before the root view appears, including cold launch.
@MainActor
final class BatteryHoldNavigationInbox: ObservableObject {
    struct Request {
        let id = UUID()
        let url: URL
    }
    static let shared = BatteryHoldNavigationInbox()
    @Published private(set) var request: Request?
    private var consumedID: UUID?

    func send(_ url: URL) { request = Request(url: url) }
    func take() -> URL? {
        guard let request, consumedID != request.id else { return nil }
        consumedID = request.id
        return request.url
    }
}

