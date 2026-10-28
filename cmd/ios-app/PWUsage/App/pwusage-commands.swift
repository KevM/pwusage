import Combine
import SwiftUI

struct PWUsageCommands: Commands {
    @ObservedObject var model: PWUsageAppModel

    var body: some Commands {
        CommandMenu("View") {
            Button("Refresh") {
                Task {
                    await model.refreshDashboard(trigger: .scheduled)
                }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(model.screenState != .signedIn)
        }

        CommandGroup(after: .newItem) {
            Button("Switch Site…") {
                model.openSitePicker()
            }
            .keyboardShortcut("k", modifiers: .command)
            .disabled(model.screenState != .signedIn || model.sites.isEmpty)
        }

        CommandGroup(after: .appInfo) {
            Button("Sign Out") {
                Task {
                    await model.signOut()
                }
            }
            .disabled(model.screenState != .signedIn || model.isSigningOut)
        }
    }
}
