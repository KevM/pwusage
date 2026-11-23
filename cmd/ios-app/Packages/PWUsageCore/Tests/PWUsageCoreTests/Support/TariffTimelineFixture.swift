import Foundation

/// A v2 site tariff timeline (site "a", Chicago, USD) shared by the core decoding tests and the
/// app's tariff tests (`project.yml` compiles this file into `PWUsageTests` too).
enum TariffTimelineFixture {
    static let json = #"{"version":2,"siteId":"a","timezone":"America/Chicago","currency":"USD","periods":["#
        + #"{"periodId":2,"tariffId":20,"name":"Residential","version":2,"source":"manual","#
        + #""effectiveFrom":"2026-01-01","effectiveTo":null,"isCurrentToday":true,"#
        + #""updatedBy":{"email":"owner@example.com","isCurrentUser":true},"#
        + #""seasons":[{"name":"Winter","fromMonth":10,"toMonth":4,"weekdayPeriods":["#
        + #"{"touName":"ON_PEAK","fromHour":8,"fromMinute":0,"toHour":20,"toMinute":0,"#
        + #""buyRate":0.30335,"sellRate":0.04906},"#
        + #"{"touName":"OFF_PEAK","fromHour":20,"fromMinute":0,"toHour":8,"toMinute":0,"#
        + #""buyRate":0.10,"sellRate":0.0329}],"weekendPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.10,"sellRate":0.0329}]}]},"#
        + #"{"periodId":1,"tariffId":10,"name":"Tesla Plan","version":1,"source":"tesla","#
        + #""effectiveFrom":"2025-01-01","effectiveTo":"2025-12-31","isCurrentToday":false,"#
        + #""updatedBy":null,"seasons":[{"name":"All Year","fromMonth":1,"toMonth":12,"weekdayPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.20,"sellRate":0.05}],"weekendPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.20,"sellRate":0.05}]}]}],"#
        + #""reattribution":{"status":"running","fromDate":"2026-01-01","toDate":null,"#
        + #""totalDays":100,"processedDays":40,"updatedDays":25,"lastError":null,"#
        + #""updatedAt":"2026-10-01T13:00:00Z"},"#
        + #""teslaSync":{"latestTariffId":10,"latestTariffName":"Tesla Plan","#
        + #""latestUpdatedAt":"2026-10-01T12:00:00Z","differsFromActiveManual": true,"#
        + #""syncAvailable": false, "syncUnavailableReason": null, "lastSync": null}}"#
}
