import SwiftUI

struct BatteryHoldSheet: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let site: MobileSite
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.reconnectTesla) private var reconnectTesla

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Form {
                    Section {
                        Text("Preserve your \(site.name) Powerwall battery level during a large load.")
                    }
                    if let response = coordinator.batteryHold.response {
                        if let notice = response.notice {
                            BatteryHoldNoticeSection(notice: notice, canDismiss: canControl(at: context.date), onDismiss: dismissNotice)
                        }
                        if !coordinator.batteryHold.statusIsCurrent(at: context.date) {
                            Section {
                                Label("Showing last confirmed status", systemImage: "clock.badge.exclamationmark")
                                    .foregroundStyle(.secondary)
                                Text("Current status is needed before changing the hold. Try again to update it.")
                            }
                        }
                        if let hold = response.hold {
                            BatteryHoldActiveSection(
                                hold: hold, timeZone: timeZone, now: context.date,
                                canRestore: canControl(at: context.date), onRestore: restore
                            )
                        } else {
                            BatteryHoldSetupSection(
                                stateOfCharge: coordinator.batteryHoldStateOfCharge(at: context.date),
                                hasTariff: hasTariff,
                                requiresReserveChoice: coordinator.batteryHold.requiresReserveChoice,
                                canStart: BatteryHoldPresentation.canStart(
                                    state: coordinator.batteryHold,
                                    stateOfCharge: coordinator.batteryHoldStateOfCharge(at: context.date),
                                    hasTariff: hasTariff, at: context.date
                                ),
                                onStart: start
                            )
                            .id(coordinator.selectedSiteID)
                        }
                    } else if !coordinator.batteryHold.isRefreshing {
                        ContentUnavailableView("Battery Hold Unavailable", systemImage: "battery.0percent",
                                               description: Text("Refresh to load the current hold status."))
                    }
                    if coordinator.batteryHold.isBusy {
                        Section { ProgressView(coordinator.batteryHold.isSubmitting ? "Updating battery hold…" : "Loading battery hold…") }
                    }
                    if let failure = coordinator.batteryHold.failure {
                        Section {
                            Text(failure.message).foregroundStyle(.secondary)
                            if failure == .needsReauthentication {
                                Button("Reconnect Tesla Account", systemImage: "person.crop.circle.badge.checkmark", action: reconnect)
                                    .disabled(reconnectTesla == nil || coordinator.batteryHold.isBusy)
                            }
                        }
                    }
                    if needsRetry(at: context.date) {
                        Section {
                            Button("Try Again", systemImage: "arrow.clockwise", action: refresh)
                                .disabled(coordinator.batteryHold.isBusy)
                        }
                    }
                }
            }
            .navigationTitle("Battery Hold")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close).disabled(coordinator.batteryHold.isSubmitting)
                }
            }
            .refreshable { await refreshData() }
            .task(id: scenePhase) { await refreshWhileActive() }
            .onChange(of: coordinator.selectedSiteID) { _, _ in dismiss() }
        }
        .interactiveDismissDisabled(coordinator.batteryHold.isSubmitting)
    }

    private func needsRetry(at now: Date) -> Bool {
        guard !coordinator.batteryHold.isBusy, coordinator.batteryHold.failure != .needsReauthentication else { return false }
        return !coordinator.batteryHold.statusIsCurrent(at: now)
            || (coordinator.batteryHold.response?.hold == nil && coordinator.batteryHoldStateOfCharge(at: now) == nil)
    }

    private var hasTariff: Bool {
        coordinator.bill.response?.loadTiming?.hasTariff ?? (coordinator.live.response?.activeTariff != nil)
    }

    private var timeZone: String {
        coordinator.live.response?.site.timezone ?? coordinator.bill.response?.site.timezone ?? TimeZone.current.identifier
    }

    private func canControl(at now: Date) -> Bool {
        BatteryHoldPresentation.canControl(state: coordinator.batteryHold, at: now)
    }

    private func close() { dismiss() }
    private func start(_ choice: BatteryHoldChoice) { send(.park(choice)) }
    private func restore() { send(.restore) }
    private func dismissNotice() { send(.dismiss) }

    private func send(_ command: BatteryHoldCommand) {
        guard coordinator.selectedSiteID == site.id else { return }
        Task { await coordinator.sendBatteryHoldCommand(command) }
    }

    private func reconnect() {
        guard let reconnectTesla else { return }
        dismiss()
        Task { await reconnectTesla.perform() }
    }

    private func refresh() { Task { await refreshData() } }

    private func refreshData() async {
        guard coordinator.selectedSiteID == site.id else { return }
        await coordinator.refreshAll(trigger: .userGesture)
        guard coordinator.selectedSiteID == site.id, !Task.isCancelled else { return }
        await coordinator.refreshBatteryHold()
    }

    private func refreshWhileActive() async {
        guard scenePhase == .active else { return }
        var force = true
        while !Task.isCancelled, coordinator.selectedSiteID == site.id {
            await coordinator.refreshBatteryHold(force: force)
            if force, coordinator.batteryHold.response != nil,
               coordinator.batteryHold.response?.hold == nil,
               coordinator.batteryHoldStateOfCharge(at: .now) == nil {
                await coordinator.refreshAll(trigger: .userGesture)
            }
            force = false
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
        }
    }
}
