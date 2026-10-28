import CryptoKit

import Foundation

extension BatteryHoldActivityCoordinator {
    func tokenReceived(_ token: Data, activityID: String) {
        guard let item = tracked[activityID], item.latestToken != token else { return }
        item.latestToken = token
        // One at a time per activity: an older token's request can't land after a newer one's.
        let previous = item.registration
        item.registration = Task {
            // Cancelling the newest registration (sign-out) cancels the queue behind it.
            await withTaskCancellationHandler {
                await previous?.value
            } onCancel: {
                previous?.cancel()
            }
            guard !Task.isCancelled else { return }
            await register(token, activityID: activityID)
        }
    }

    func register(_ token: Data, activityID: String) async {
        guard let apnsEnvironment, let item = tracked[activityID] else { return }
        let attributes = item.handle.attributes
        let digest = SHA256.hash(data: token).map { String(format: "%02x", $0) }.joined()
        if store.entry(attributes.registrationID)?.tokenDigest == digest { return }
        let registration = BatteryHoldActivityRegistration(
            holdId: attributes.holdID,
            registrationId: attributes.registrationID.uuidString.lowercased(),
            pushToken: token.map { String(format: "%02x", $0) }.joined(),
            apnsEnvironment: apnsEnvironment
        )
        let generation = generation
        for attempt in 0 ... Self.retryDelays.count {
            // A rotated token or ended activity makes this attempt pointless.
            guard generation == self.generation, tracked[activityID]?.latestToken == token else { return }
            do {
                try await api.registerBatteryHoldActivity(siteID: attributes.siteID, registration: registration)
                guard generation == self.generation else { return }
                store.record(.init(registrationID: attributes.registrationID, siteID: attributes.siteID,
                                   holdID: attributes.holdID, tokenDigest: digest))
                // Ended while the request was in flight: don't leave it registered.
                if tracked[activityID] == nil { await unregister(attributes) }
                return
            } catch let error as PWUsageAPIError {
                guard generation == self.generation else { return }
                switch error {
                case .signInRequired:
                    return
                case .requestRejected(403, _):
                    // Access to this site is gone: clear its private presentation.
                    if let item = tracked[activityID] { await end(item, as: nil, immediately: true) }
                    return
                case .requestRejected(404, _), .requestRejected(410, _):
                    // The hold ended or this registration was retired; the site's status says which.
                    await refreshSite(attributes.siteID)
                    return
                case .requestRejected(let status, let message):
                    logger.error("Live Activity registration rejected: \(status, privacy: .public) \(message ?? "", privacy: .public)")
                    return
                case .recoverableServerError, .invalidResponse:
                    break
                }
            } catch {
                guard generation == self.generation else { return }
            }
            guard attempt < Self.retryDelays.count else { break }
            do { try await sleep(Self.retryDelays[attempt]) } catch { return }
        }
        logger.error("Live Activity registration failed after retries; next foreground reconcile retries")
        tracked[activityID]?.latestToken = nil
    }

    func unregister(_ attributes: BatteryHoldActivityAttributes) async {
        await unregister(siteID: attributes.siteID, registrationID: attributes.registrationID)
    }

    func unregister(siteID: String, registrationID: UUID) async {
        let generation = generation
        guard sessionActive else { return }
        do {
            try await api.unregisterBatteryHoldActivity(siteID: siteID, registrationID: registrationID)
            guard generation == self.generation else { return }
            store.remove(registrationID)
        } catch PWUsageAPIError.requestRejected {
            guard generation == self.generation else { return }
            store.remove(registrationID)
        } catch {
            // Kept for the next reconcile; expiry and invalid-token cleanup cover the rest.
        }
    }

    // MARK: Reconcile

    func reconcile() async {
        // A request that arrives mid-run (new sites, say) runs again rather than being dropped.
        reconcileRequested = true
        guard !isReconciling else { return }
        isReconciling = true
        defer { isReconciling = false }
        while reconcileRequested, sessionActive {
            reconcileRequested = false
            await reconcileOnce()
        }
    }

    func reconcileOnce() async {
        let generation = generation
        let running = host.activities()
        for handle in running {
            let attributes = handle.attributes
            if siteNames[attributes.siteID] == nil {
                _ = untrack(handle.id)
                await handle.end(nil, immediately: true)
                await unregister(attributes)
            } else if handle.lifecycle == .pending {
                continue
            } else if handle.lifecycle == .active || handle.lifecycle == .stale {
                track(handle)
                // Retries a registration that gave up, or a token rotated while suspended.
                if let token = handle.pushToken { tokenReceived(token, activityID: handle.id) }
            } else {
                _ = untrack(handle.id)
                if store.entry(attributes.registrationID) != nil { await unregister(attributes) }
            }
            guard generation == self.generation else { return }
        }
        let live = Set(tracked.values.map(\.handle.attributes.registrationID))
        for entry in store.entries where !live.contains(entry.registrationID) {
            await unregister(siteID: entry.siteID, registrationID: entry.registrationID)
            guard generation == self.generation else { return }
        }
        // Reads the database-backed status only; never a Tesla request.
        for siteID in Set(tracked.values.map(\.handle.attributes.siteID)) {
            await refreshSite(siteID)
            guard generation == self.generation else { return }
        }
    }

    func refreshSite(_ siteID: String) async {
        let generation = generation
        let current = activityIDs(siteID: siteID)
        guard let response = try? await api.fetchBatteryHold(siteID: siteID).validating(siteID: siteID),
              generation == self.generation, sessionActive else { return }
        await apply(response, siteID: siteID, to: current)
    }

    func activityIDs(siteID: String) -> Set<String> {
        Set(trackedItems(siteID: siteID).map(\.handle.id))
    }
}
