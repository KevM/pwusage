import Foundation

extension BatteryHoldActivityCoordinator {
    func batteryHoldConfirmed(_ confirmation: BatteryHoldConfirmation, siteID: String, timeZone: String?) {
        guard sessionActive else { return }
        switch confirmation {
        case .started(let hold):
            start(hold, siteID: siteID, timeZone: timeZone)
        case .refreshed(let response):
            let current = activityIDs(siteID: siteID)
            Task { await apply(response, siteID: siteID, to: current) }
        case .stopped(let holdID):
            Task {
                for item in trackedItems(siteID: siteID) where item.handle.attributes.holdID == holdID {
                    await end(item, as: item.handle.state.ended(as: .restored, reason: .manual, at: now()))
                }
            }
        }
    }

    /// The sheet's offer, for a hold started elsewhere or whose activity was dismissed.
    func show(_ hold: BatteryHold, siteID: String, timeZone: String?) {
        guard sessionActive else { return }
        start(hold, siteID: siteID, timeZone: timeZone)
    }

    func start(_ hold: BatteryHold, siteID: String, timeZone: String?) {
        guard hold.status == .active, hold.siteID == siteID, let siteName = siteNames[siteID] else { return }
        let state = BatteryHoldActivityAttributes.ContentState(hold: hold)
        // An activity from before a relaunch that reconcile hasn't reached yet.
        for handle in host.activities() where handle.attributes.siteID == siteID && handle.attributes.holdID == hold.id
            && (handle.lifecycle == .active || handle.lifecycle == .stale) {
            track(handle)
        }
        if let existing = trackedItems(siteID: siteID).first(where: { $0.handle.attributes.holdID == hold.id }) {
            Task { await update(existing, to: state) }
            return
        }
        // A site shows one hold. Anything else for it is over, including a finished
        // activity still on the Lock Screen, so remove it rather than leave two.
        let others = host.activities().filter { $0.attributes.siteID == siteID && $0.attributes.holdID != hold.id }
        Task {
            for handle in others {
                if let item = tracked[handle.id] { await end(item, as: nil, immediately: true) }
                else { await handle.end(nil, immediately: true) }
            }
        }
        guard host.activitiesEnabled else { return }
        let attributes = BatteryHoldActivityAttributes(
            siteID: siteID, siteName: siteName, holdID: hold.id, registrationID: UUID(),
            timeZoneIdentifier: timeZone ?? TimeZone.current.identifier, activityStartedAt: now()
        )
        do {
            track(try host.start(attributes: attributes, state: state))
        } catch {
            logger.error("Live Activity start failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    /// Applies a site read to the activities that existed when it was taken. One
    /// started since is newer than the read, which mustn't end it.
    func apply(_ response: BatteryHoldResponse, siteID: String, to activityIDs: Set<String>) async {
        for item in trackedItems(siteID: siteID) where activityIDs.contains(item.handle.id) {
            let holdID = item.handle.attributes.holdID
            if let hold = response.hold, hold.id == holdID {
                await update(item, to: .init(hold: hold))
            } else if let notice = response.notice, notice.id == holdID {
                await end(item, as: item.handle.state.ended(
                    as: .cancelled, reason: .reserveChanged, at: now(), observedReserve: notice.cancelledObservedReserve))
            } else {
                // Restored, or replaced by a newer hold. This read doesn't say which,
                // so the activity doesn't claim a restoration it hasn't seen.
                await end(item, as: item.handle.state.ended(as: .ended, at: now()))
            }
        }
    }

    func update(_ item: Tracked, to state: BatteryHoldActivityAttributes.ContentState) async {
        let current = item.handle.state
        // A push may already have delivered something newer than this read.
        guard state != current, state.dataTime >= current.dataTime, current.status == .active else { return }
        await item.handle.update(state)
    }

    // MARK: Tracking

    func trackedItems(siteID: String) -> [Tracked] {
        tracked.values.filter { $0.handle.attributes.siteID == siteID }
    }

    func track(_ handle: any BatteryHoldActivityHandle) {
        guard tracked[handle.id] == nil else { return }
        let item = Tracked(handle: handle)
        let activityID = handle.id
        let tokens = handle.pushTokenUpdates()
        let lifecycles = handle.lifecycleUpdates()
        item.observers = [
            Task { [weak self] in
                for await token in tokens { self?.tokenReceived(token, activityID: activityID) }
            },
            Task { [weak self] in
                for await lifecycle in lifecycles where lifecycle == .ended || lifecycle == .dismissed {
                    await self?.observedEnd(activityID: activityID)
                }
            },
        ]
        tracked[activityID] = item
        shownHoldIDs.insert(handle.attributes.holdID)
        if let token = handle.pushToken { tokenReceived(token, activityID: activityID) }
    }

    func untrack(_ activityID: String) -> Tracked? {
        guard let item = tracked.removeValue(forKey: activityID) else { return nil }
        item.observers.forEach { $0.cancel() }
        shownHoldIDs = Set(tracked.values.map(\.handle.attributes.holdID))
        return item
    }

    func end(_ item: Tracked, as state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool = false) async {
        guard untrack(item.handle.id) != nil else { return }
        await item.handle.end(state, immediately: immediately)
        await unregister(item.handle.attributes)
    }

    func observedEnd(activityID: String) async {
        guard let item = untrack(activityID) else { return }
        await unregister(item.handle.attributes)
    }

    // MARK: Registration
}
