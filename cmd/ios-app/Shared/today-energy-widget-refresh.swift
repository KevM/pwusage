import Foundation

/// Fetches within WidgetKit's timeline invocation, independently of the app lifecycle.
struct TodayEnergyWidgetRefresh: Sendable {
    let origin: URL
    let session: URLSession
    let store: TodayEnergySnapshotStore

    private struct CachedRefresh: Codable {
        let origin: URL
        let selection: TodayEnergySnapshot
        // nil records rejected authorization, preventing offline fallback to revoked data.
        let snapshot: TodayEnergySnapshot?
    }

    private var cacheURL: URL {
        store.refreshFileURL
    }

    static func current() async -> TodayEnergySnapshot? {
        await TodayEnergyWidgetRefreshCoordinator.shared.current()
    }

    fileprivate static func fetchCurrent() async -> TodayEnergySnapshot? {
        guard let store = TodayEnergySnapshotStore.shared(),
              let configuration = try? AppConfiguration.fromBundle() else { return nil }
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }
        return await Self(origin: configuration.apiOrigin, session: session, store: store).load()
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = SharedWebSession.cookieStorage()
        configuration.httpShouldSetCookies = true
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        return URLSession(configuration: configuration)
    }

    func load(at date: Date? = nil) async -> TodayEnergySnapshot? {
        let now = date ?? Date()
        guard let selection = store.load() else { return nil }
        let matchingCache = cachedRefresh(for: selection)
        let fallback = matchingCache.map { $0.snapshot } ?? selection
        // Several widget kinds can request the same site around the same time.
        if let cached = matchingCache?.snapshot, let fresh = currentSnapshot(cached, at: now) { return fresh }
        if matchingCache == nil, let fresh = currentSnapshot(selection, at: now) { return fresh }

        return await fetch(selection: selection, fallback: fallback, at: date)
    }

    private func cachedRefresh(for selection: TodayEnergySnapshot) -> CachedRefresh? {
        let cached = (try? Data(contentsOf: cacheURL))
            .flatMap { try? JSONDecoder().decode(CachedRefresh.self, from: $0) }
        return cached.flatMap { $0.origin == origin && $0.selection == selection ? $0 : nil }
    }

    private func currentSnapshot(_ snapshot: TodayEnergySnapshot, at now: Date) -> TodayEnergySnapshot? {
        let age = now.timeIntervalSince(snapshot.fetchedAt)
        guard age >= 0, age < 5 * 60, snapshot.availability(at: now) == .current else { return nil }
        return snapshot
    }

    private func fetch(
        selection: TodayEnergySnapshot, fallback: TodayEnergySnapshot?, at date: Date?
    ) async -> TodayEnergySnapshot? {
        do {
            guard let url = requestURL(for: selection) else { return fallback }
            let (data, response) = try await session.data(
                for: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
            )
            return try interpret(data: data, response: response, selection: selection,
                                 fallback: fallback, at: date)
        } catch {
            return store.load() == selection ? fallback : store.load()
        }
    }

    private func requestURL(for selection: TodayEnergySnapshot) -> URL? {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        components?.path = "/api/site-live-data"
        components?.queryItems = [URLQueryItem(name: "siteId", value: selection.siteID),
                                  URLQueryItem(name: "view", value: "mobile")]
        return components?.url
    }

    private func interpret(
        data: Data,
        response: URLResponse,
        selection: TodayEnergySnapshot,
        fallback: TodayEnergySnapshot?,
        at date: Date?
    ) throws -> TodayEnergySnapshot? {
        // Sign-out or a different app selection invalidates any in-flight widget result.
        guard store.load() == selection else { return store.load() }
        guard let http = response as? HTTPURLResponse else { return fallback }
        if http.statusCode == 401 || http.statusCode == 403 {
            save(nil, selection: selection)
            return nil
        }
        guard (200 ..< 300).contains(http.statusCode) else { return fallback }
        // Validate against receipt time: the server may have refreshed SOC during the request.
        let receivedAt = date ?? Date()
        let live = try MobileContractDecoder.make(now: { receivedAt }).decode(MobileLiveResponse.self, from: data)
        guard live.site.id == selection.siteID else { return fallback }
        let value = TodayEnergySnapshot(
            siteID: live.site.id, siteName: live.site.name, timezone: live.site.timezone, fetchedAt: receivedAt,
            energy: TodayEnergy(localDate: live.site.localDate, homeKwh: live.today.homeKwh,
                                solarKwh: live.today.solarKwh, gridNetKwh: live.today.gridNetKwh,
                                batteryNetKwh: live.today.batteryNetKwh, activeTariff: live.activeTariff,
                                todayComplete: live.todayComplete,
                                energyDataThrough: live.sources.energyDataThrough),
            todayCost: live.todayCost, batteryStateOfCharge: live.stateOfCharge,
            batteryStateOfChargeAt: live.sources.stateOfChargeAt)
        guard value.availability(at: receivedAt) != .missing else { return fallback }
        save(value, selection: selection)
        return value
    }

    private func save(_ snapshot: TodayEnergySnapshot?, selection: TodayEnergySnapshot) {
        // Never write the app's selection file: a late widget write must not undo logout.
        let value = CachedRefresh(origin: origin, selection: selection, snapshot: snapshot)
        try? JSONEncoder().encode(value).write(
            to: cacheURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }
}

// Widget kinds share the extension process. Actor reentrancy must not start a second fetch.
private actor TodayEnergyWidgetRefreshCoordinator {
    static let shared = TodayEnergyWidgetRefreshCoordinator()
    private var pending: Task<TodayEnergySnapshot?, Never>?

    func current() async -> TodayEnergySnapshot? {
        if let pending { return await pending.value }
        let task = Task { await TodayEnergyWidgetRefresh.fetchCurrent() }
        pending = task
        let value = await task.value
        pending = nil
        return value
    }
}
