import BackgroundTasks
import Foundation
import OSLog

/// iOS chooses actual execution time. This request is only an opportunity to refresh;
/// recommendations still enforce the provider's normal cache age and coverage checks.
enum BackgroundSolarForecastRefresh {
    static let identifier = "fm.rodeo.pwusage.solar-forecast-refresh"

    static func request(now: Date = Date()) -> BGAppRefreshTaskRequest {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = now.addingTimeInterval(SolarForecastStore.foregroundRefreshThreshold)
        return request
    }

    static func schedule() {
        do { try BGTaskScheduler.shared.submit(request()) } catch {
            Logger(subsystem: "fm.rodeo.pwusage", category: "solar-background")
                .debug("Background solar refresh could not be scheduled")
        }
    }

    /// Authenticated background metadata gets the same Low Data Mode policy as the weather
    /// request. Use the existing cookie jar without weakening credential storage.
    static func api() throws -> PWUsageAPI {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = SharedWebSession.cookieStorage()
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.allowsConstrainedNetworkAccess = false
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 10
        return try PWUsageAPI(
            configuration: AppConfiguration.fromBundle(), session: URLSession(configuration: configuration)
        )
    }
}
