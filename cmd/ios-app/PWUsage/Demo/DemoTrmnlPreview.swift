import Foundation

/// Builds a TRMNL preview document for Cedar House using the real TRMNL framework
/// stylesheet (`plugins.css`) and the same `TrmnlRenderer` markup structure used on
/// `/help/trmnl`, so Demo Mode's Settings > Trmnl preview matches a real device screen.
enum DemoTrmnlPreview {
    /// Pinned to match `TRMNL_FRAMEWORK_VERSION` in `cmd/next-app/src/lib/trmnl-preview-document.ts`.
    static let frameworkVersion = "3.4.6"
    static let assetHost = "https://trmnl.com/"

    struct PeriodRow {
        let name: String
        let isActive: Bool
        let homeKwh: Int
        let solarKwh: Int
        let gridKwh: Int
        let batteryKwh: Int
        let cost: Double
    }

    private struct ScreenData {
        let headerTitle: String
        let dateRange: String
        let rows: [PeriodRow]
        let totalCost: Double
        let onPeakOwedKwh: Int
        let offPeakOwedKwh: Int
    }

    static func document(bill: MobileBillResponse, asOf: Date) -> String {
        let onPeak = bill.currentBill.periods.first { $0.periodName == DemoFixtures.onPeak.name }
        let offPeak = bill.currentBill.periods.first { $0.periodName == DemoFixtures.offPeak.name }
        let onPeakGrid = Int((onPeak?.netGridKwh ?? 0).rounded())
        let offPeakGrid = Int((offPeak?.netGridKwh ?? 0).rounded())
        let rows = [
            PeriodRow(
                name: DemoFixtures.offPeak.name, isActive: false,
                homeKwh: offPeakGrid + 68, solarKwh: 82, gridKwh: offPeakGrid,
                batteryKwh: -14, cost: offPeak?.cost ?? 0
            ),
            PeriodRow(
                name: DemoFixtures.onPeak.name, isActive: true,
                homeKwh: onPeakGrid + 96, solarKwh: 112, gridKwh: onPeakGrid,
                batteryKwh: -16, cost: onPeak?.cost ?? 0
            )
        ]
        let data = ScreenData(
            headerTitle: "\(DemoFixtures.site.name) @ \(clockText(asOf))",
            dateRange: dateRangeText(start: bill.currentBill.cycleStart, end: bill.currentBill.cycleEnd),
            rows: rows,
            totalCost: bill.currentBill.estimatedCost ?? 0,
            onPeakOwedKwh: onPeakGrid,
            offPeakOwedKwh: offPeakGrid
        )
        return wrapDocument(screenMarkup(data))
    }

    private static func wrapDocument(_ markup: String) -> String {
        """
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=800, initial-scale=1" />
          <base href="\(assetHost)" />
          <link rel="stylesheet" href="\(assetHost)css/\(frameworkVersion)/plugins.css" />
          <style>
            html, body { margin: 0; padding: 0; width: 800px; height: 480px; overflow: hidden; background: #fff; }
          </style>
        </head>
        <body class="environment trmnl"><div class="screen">\(markup)</div></body>
        </html>
        """
    }

    private static func screenMarkup(_ data: ScreenData) -> String {
        """
        <div class="view view--full">
          <div class="layout layout--col gap--small h--full">
            \(liveStatsBar)
            \(billTable(data))
            \(smartShiftSection(onPeakOwedKwh: data.onPeakOwedKwh, offPeakOwedKwh: data.offPeakOwedKwh))
          </div>
        </div>
        """
    }

    private static var liveStatsBar: String {
        let fillWidth = String(format: "%.2f", Double(DemoFixtures.stateOfCharge) / 100.0 * 18.0)
        return """
        <div class="w--full" style="position: relative; height: 74px; min-height: 74px;">
          <div class="flex flex--row flex--center-y flex--center-x gap--xxlarge" style="height: 100%;">
            <div class="flex flex--row flex--center-y flex--center-x gap--small">
              <span class="title title--xxlarge" style="font-size: 52px; line-height: 1;">-0.7</span>
              \(gridIcon)
            </div>
            <div class="flex flex--row flex--center-y flex--center-x gap--small">
              <span class="title title--xxlarge" style="font-size: 52px; line-height: 1;">3.9</span>
              \(solarIcon)
            </div>
            <div class="flex flex--col flex--center-x">
              <div class="flex flex--row flex--center-y gap--small">
                <div class="flex flex--row flex--center-y">
                  <span class="title title--xxlarge" style="font-size: 54px; line-height: 1;">
                    \(DemoFixtures.stateOfCharge)%
                  </span>
                </div>
                <div class="flex flex--row flex--center-y gap--xsmall">
                  \(batteryGlyph(fillWidth: fillWidth))
                  <div>\(chargingIcon)</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        """
    }

    private static func billTable(_ data: ScreenData) -> String {
        let bodyRows = data.rows.map(periodRowHTML).joined()
        let totalText = String(format: "$%.2f", data.totalCost)
        return """
        <div class="flex flex--col w--full">
          <div class="flex flex--row flex--center-y w--full"
               style="justify-content: space-between; margin-bottom: 4px;">
            <span class="title title--small" style="font-size: 15px; line-height: 1;">\(data.headerTitle)</span>
            <span class="value value--small" style="font-size: 13px; font-weight: 700; line-height: 1;">
              \(data.dateRange)
            </span>
          </div>
          <table class="table w--full">
            <thead>
              <tr>
                <th>Period</th><th>Home</th><th>Solar</th><th>Grid</th><th>Batt</th><th>Cost</th>
              </tr>
            </thead>
            <tbody>
              \(bodyRows)
              <tr>
                <td class="table-col"><span class="title title--medium"><strong>Total Cost</strong></span></td>
                <td colspan="4"></td>
                <td class="table-col"><span class="title title--medium"><strong>\(totalText)</strong></span></td>
              </tr>
            </tbody>
          </table>
        </div>
        """
    }

    private static func periodRowHTML(_ row: PeriodRow) -> String {
        let prefix = row.isActive ? "&gt; " : ""
        let cost = String(format: "$%.2f", row.cost)
        return """
        <tr>
          <td><span class="value--small">\(prefix)\(row.name)</span></td>
          <td><span class="value--small">\(row.homeKwh)</span></td>
          <td><span class="value--small">\(row.solarKwh)</span></td>
          <td><span class="value--small">\(row.gridKwh)</span></td>
          <td><span class="value--small">\(row.batteryKwh)</span></td>
          <td><span class="value--small">\(cost)</span></td>
        </tr>
        """
    }

    private static func smartShiftSection(onPeakOwedKwh: Int, offPeakOwedKwh: Int) -> String {
        """
        <div class="flex flex--col w--full gap--small"
             style="height: 156px; min-height: 156px; overflow: hidden;">
          <div class="flex flex--row flex--center-x w--full">
            <span class="title title--medium">Wait until Off-peak in 3 hours</span>
          </div>
          <div class="flex flex--row flex--center-x w--full gap--xxlarge"
               style="flex: 1 1 auto; align-items: flex-start;">
            <div class="flex flex--col flex--center-x" style="flex: 1 1 0;">
              <span class="value value--small"><strong>ACTIVE NOW</strong></span>
              <span class="title title--small"><strong>\(DemoFixtures.onPeak.name)</strong></span>
              <span class="title title--medium">31¢/kWh</span>
              <span class="label">\(onPeakOwedKwh) kWh owed</span>
            </div>
            <div class="flex flex--col flex--center-x" style="flex: 1 1 0;">
              <span class="label">Next in 3 hours</span>
              <span class="title title--small">\(DemoFixtures.offPeak.name)</span>
              <span class="title title--small">10¢/kWh</span>
              <span class="label">\(offPeakOwedKwh) kWh owed</span>
            </div>
          </div>
        </div>
        """
    }

    private static func clockText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = DemoFixtures.timeZone
        formatter.dateFormat = "h:mma"
        return formatter.string(from: date).lowercased()
    }

    private static func dateRangeText(start: Date, end: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = DemoFixtures.timeZone
        formatter.dateFormat = "M/d"
        return "\(formatter.string(from: start)) - \(formatter.string(from: end))"
    }

    private static func batteryGlyph(fillWidth: String) -> String {
        """
        <svg xmlns="http://www.w3.org/2000/svg" width="81" height="41" viewBox="0 0 26 14">
          <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
          <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
          <rect x="2.5" y="2.5" width="\(fillWidth)" height="9" rx="0.5" fill="black" />
        </svg>
        """
    }

    private static let gridIcon = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="52" height="52">
      <path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/>
    </svg>
    """

    private static let solarIcon = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="52" height="52"
         fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="5" fill="black" stroke="none"/>
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
    </svg>
    """

    private static let chargingIcon = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="black">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90, 12, 12)"/>
    </svg>
    """
}
