import Foundation
import Testing
import UIKit
import SwiftUI
@testable import PWUsage

@MainActor
@Suite("Battery hold navigation", .serialized)
struct BatteryHoldNavigationTests {
    @Test("The control's icon is a system symbol that exists")
    func controlSymbolIsSystemSymbol() {
        // The control ships a system symbol (see the README on custom glyphs). A
        // misspelled or unavailable system name renders blank with no error.
        #expect(UIImage(systemName: BatteryHoldControlIdentity.symbolName) != nil)
    }

    @Test("Site identifiers round trip without changing their meaning")
    func links() throws {
        for id in ["site-2", "a/b?c=d&e", "a space", "家"] {
            #expect(BatteryHoldLink.siteID(from: BatteryHoldLink.url(siteID: id)) == id)
        }
        #expect(BatteryHoldLink.siteID(from: try #require(URL(string: "pwusage://battery-hold?site=a#other"))) == nil)
    }

    @Test("Intent mailbox retains a cold-launch request and consumes each tap once")
    func coldLaunchMailbox() throws {
        let inbox = BatteryHoldNavigationInbox()
        let url = BatteryHoldLink.url(siteID: "site-2")
        inbox.send(url)
        #expect(inbox.take() == url)
        #expect(inbox.take() == nil)
        inbox.send(url)
        #expect(inbox.take() == url)
    }

    @Test("The app navigation intent only queues its explicit site")
    func intentRouting() async throws {
        let intent = OpenBatteryHoldIntent(site: .init(id: "site-2", name: "Second home"))
        _ = try await intent.perform()
        #expect(BatteryHoldNavigationInbox.shared.take() == BatteryHoldLink.url(siteID: "site-2"))
    }

    @Test("Picker metadata replaces removed sites and clears on logout")
    func pickerStore() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BatteryHoldControlSiteStore(fileURL: directory.appendingPathComponent("sites.json"))
        #expect(store.load().isEmpty)
        store.save([.init(id: "site-1", name: "Home"), .init(id: "site-2", name: "Cabin")])
        #expect(store.load().count == 2)
        store.save([.init(id: "site-2", name: "Cabin")])
        #expect(store.load().map(\.id) == ["site-2"])
        store.clear()
        #expect(store.load().isEmpty)
    }
}
