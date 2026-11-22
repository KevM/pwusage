/**
 * HTML document for a TRMNL screen preview, shared by the web preview (sandboxed iframe srcdoc)
 * and the iOS app (WKWebView loadHTMLString).
 *
 * It renders our markup with TRMNL's own framework stylesheet and the same body/screen wrapper
 * TRMNL uses (see usetrmnl/trmnlp web/views/render_html.erb), so fonts, spacing and tables match
 * the device instead of a hand-maintained approximation.
 */

/**
 * TRMNL framework release to render against. Pinned so an upstream release cannot silently change
 * our previews; bump deliberately and compare against a real device screen. Versions are listed in
 * usetrmnl/trmnl-framework db/data/framework_versions.yml.
 */
export const TRMNL_FRAMEWORK_VERSION = '3.4.6';

const TRMNL_ASSET_HOST = 'https://trmnl.com/';

export function buildTrmnlPreviewDocument(markup: string): string {
    // plugins.css references root-relative /fonts/*; the base makes them resolve to trmnl.com
    // in both the srcdoc iframe and the iOS web view (which loads with no base URL).
    // No plugins.js: the web iframe is sandboxed with scripts off, and our markup uses no
    // script-driven framework features, so both previews stay CSS-only and identical.
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=800, initial-scale=1" />
  <base href="${TRMNL_ASSET_HOST}" />
  <link rel="stylesheet" href="${TRMNL_ASSET_HOST}css/${TRMNL_FRAMEWORK_VERSION}/plugins.css" />
  <style>
    html, body { margin: 0; padding: 0; width: 800px; height: 480px; overflow: hidden; background: #fff; }
  </style>
</head>
<body class="environment trmnl"><div class="screen">${markup}</div></body>
</html>`;
}
