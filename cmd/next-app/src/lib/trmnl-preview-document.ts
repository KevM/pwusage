/** Self-contained HTML document for a TRMNL screen, shared by the web preview and the iOS app. */

const TRMNL_PREVIEW_CSS = `
html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #fff;
  color: #000;
  font-family: "IBM Plex Sans", "Arial", sans-serif;
}
* { box-sizing: border-box; }
.view, .layout { width: 100%; height: 100%; }
.layout--col { display: flex; flex-direction: column; }
.layout--center { align-items: center; justify-content: center; }
.flex { display: flex; }
.flex--row { flex-direction: row; }
.flex--col { flex-direction: column; }
.flex--center-x { justify-content: center; }
.flex--center-y { align-items: center; }
.flex--stretch-x { justify-content: stretch; }
.w--full { width: 100%; }
.h--full { height: 100%; }
.gap--xsmall { gap: 4px; }
.gap--small { gap: 8px; }
.gap--medium { gap: 12px; }
.gap--large { gap: 18px; }
.gap--xlarge { gap: 26px; }
.gap--xxlarge { gap: 38px; }
.title { display: inline-block; line-height: 1.05; font-weight: 600; }
.title--xxlarge { font-size: 56px; }
.title--medium { font-size: 22px; }
.title--small { font-size: 17px; }
.label { display: inline-block; font-size: 14px; line-height: 1.1; font-weight: 500; }
.label--small { font-size: 12px; }
.value { display: inline-block; font-size: 20px; line-height: 1.1; }
.value--large { font-size: 26px; }
.value--small { font-size: 14px; }
.value--xsmall { font-size: 12px; }
.table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.table th, .table td {
  text-align: center;
  padding: 2px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}
.table th { font-size: 11px; font-weight: 600; }
.table td { font-size: 12px; font-weight: 500; }
.table-col { text-align: left !important; }
.mb-2 { margin-bottom: 8px; }
svg { shape-rendering: geometricPrecision; }
`;

export function buildTrmnlPreviewDocument(markup: string): string {
    const CONTENT_SAFE_SCALE = 0.9;
    const CONTENT_SAFE_OFFSET_X = Math.round((800 - (800 * CONTENT_SAFE_SCALE)) / 2);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=800, initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 800px;
      height: 480px;
      overflow: hidden;
    }
    #trmnl-root {
      width: 800px;
      height: 480px;
      transform: translateX(${CONTENT_SAFE_OFFSET_X}px) scale(${CONTENT_SAFE_SCALE});
      transform-origin: top left;
    }
    ${TRMNL_PREVIEW_CSS}
  </style>
</head>
<body>
  <div id="trmnl-root">${markup}</div>
</body>
</html>`;
}
