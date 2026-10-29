#if DEBUG
    import Foundation

    /// Local-only fixtures for the native hold sheet, including interactive commands.
    @MainActor
    final class BatteryHoldPreviewAPI: MobileDashboardDataAPI, MobileBatteryHoldDataAPI {
        enum Mode { case idle, ambiguous, active, monitoring, notice }
        private let mode: Mode
        private let dashboard = DashboardPreviewAPI(mode: .normal)
        private var response: BatteryHoldResponse

        init(mode: Mode) {
            self.mode = mode
            let now = Date.now
            let hold = BatteryHold(
                id: 1, siteID: "preview-home", status: mode == .notice ? .cancelled : .active,
                mode: mode == .monitoring ? .auto : .timer, originalReserve: 20, targetReserve: 80,
                createdAt: now.addingTimeInterval(-3600), safetyExpiresAt: now.addingTimeInterval(3 * 3600),
                cancelledObservedReserve: mode == .notice ? 45 : nil,
                monitoring: mode == .monitoring ? .init(phase: .loadRunning, checkedAt: now.addingTimeInterval(-60),
                                                        nextCheckAt: now.addingTimeInterval(8 * 60), sampledAt: now.addingTimeInterval(-5 * 60), estimatedLoadW: 9000) : nil
            )
            response = .init(hold: (mode == .active || mode == .monitoring) ? hold : nil, notice: mode == .notice ? hold : nil)
        }

        func fetchLive(siteID: String) async throws -> MobileLiveResponse {
            let live = try await dashboard.fetchLive(siteID: siteID)
            guard mode == .ambiguous else { return live }
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let json = String(decoding: try encoder.encode(live), as: UTF8.self)
                .replacingOccurrences(of: "\"stateOfCharge\":72", with: "\"stateOfCharge\":90")
            return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
        }

        func fetchBill(siteID: String) async throws -> MobileBillResponse { try await dashboard.fetchBill(siteID: siteID) }
        func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse { response }

        func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult {
            switch command {
            case .park(let choice):
                let now = Date.now
                let hold = BatteryHold(
                    id: 2, siteID: siteID, status: .active, mode: choice.mode,
                    originalReserve: 20, targetReserve: mode == .ambiguous ? (choice.reserveChoice ?? 100) : 72,
                    createdAt: now,
                    safetyExpiresAt: now.addingTimeInterval(Double(choice.mode == .timer ? choice.durationHours : 8) * 3600),
                    cancelledObservedReserve: nil
                )
                response = .init(hold: hold, notice: response.notice)
                return .init(status: .operational, hold: hold, current: nil)
            case .restore: response = .init(hold: nil, notice: response.notice)
            case .dismiss: response = .init(hold: response.hold, notice: nil)
            }
            return .init(status: .operational, hold: nil, current: nil)
        }
    }
#endif
