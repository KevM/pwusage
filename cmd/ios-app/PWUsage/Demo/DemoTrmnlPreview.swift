import Foundation

/// Self-contained 800x480 monochrome e-ink preview of Cedar House's default Trmnl screen,
/// rendered offline in `TrmnlPreviewWebView` for the Settings > Trmnl intro screen in Demo Mode.
enum DemoTrmnlPreview {
    static let defaultDocument = """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=800, initial-scale=1" />
    <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; width: 800px; height: 480px; overflow: hidden;
      background: #fff; color: #000; font-family: -apple-system, Helvetica, Arial, sans-serif;
    }
    .screen {
      width: 800px; height: 480px; padding: 28px 34px;
      display: flex; flex-direction: column; gap: 18px;
    }
    .header {
      display: flex; justify-content: space-between; align-items: baseline;
      border-bottom: 2px solid #000; padding-bottom: 10px;
    }
    .site { font-size: 28px; font-weight: 700; }
    .rate { font-size: 16px; font-weight: 600; }
    .stats { display: flex; gap: 14px; }
    .stat { flex: 1; border: 2px solid #000; border-radius: 8px; padding: 12px 16px; }
    .label { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .value { font-size: 32px; font-weight: 700; margin-top: 4px; }
    .detail { font-size: 14px; margin-top: 4px; color: #222; }
    .panels { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .panel {
      border: 2px solid #000; border-radius: 8px; padding: 14px 16px;
      display: flex; flex-direction: column; justify-content: space-between;
    }
    .panel-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .chart { width: 100%; height: 96px; display: block; }
    </style>
    </head>
    <body>
    <div class="screen">
      <div class="header">
        <div class="site">\(DemoFixtures.site.name)</div>
        <div class="rate">On-peak · 31¢/kWh</div>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="label">Grid</div>
          <div class="value">0.7 kW</div>
          <div class="detail">Exporting</div>
        </div>
        <div class="stat">
          <div class="label">Solar</div>
          <div class="value">3.9 kW</div>
          <div class="detail">Producing</div>
        </div>
        <div class="stat">
          <div class="label">Battery</div>
          <div class="value">1.8 kW</div>
          <div class="detail">Charging</div>
        </div>
      </div>
      <div class="panels">
        <div class="panel">
          <div class="panel-title">Today's energy</div>
          <svg class="chart" viewBox="0 0 320 90" aria-hidden="true">
            <line x1="0" y1="84" x2="320" y2="84" stroke="#000" stroke-width="1.5"/>
            <rect x="16" y="64" width="16" height="20" fill="#888"/>
            <rect x="52" y="54" width="16" height="30" fill="#888"/>
            <rect x="88" y="42" width="16" height="42" fill="#000"/>
            <rect x="124" y="22" width="16" height="62" fill="#000"/>
            <rect x="160" y="14" width="16" height="70" fill="#000"/>
            <rect x="196" y="18" width="16" height="66" fill="#000"/>
            <rect x="232" y="34" width="16" height="50" fill="#000"/>
            <rect x="268" y="56" width="16" height="28" fill="#888"/>
          </svg>
          <div class="detail">Solar 15.2 kWh · Home 21.6 kWh</div>
        </div>
        <div class="panel">
          <div class="panel-title">Battery level · \(DemoFixtures.stateOfCharge)%</div>
          <svg class="chart" viewBox="0 0 320 90" aria-hidden="true">
            <line x1="0" y1="84" x2="320" y2="84" stroke="#000" stroke-width="1.5"/>
            <polyline fill="none" stroke="#000" stroke-width="3"
              points="0,62 40,66 80,68 120,60 160,46 200,36 240,32 280,28 320,30"/>
          </svg>
          <div class="detail">20% reserve · \(DemoFixtures.stateOfCharge)% now</div>
        </div>
      </div>
    </div>
    </body>
    </html>
    """
}
