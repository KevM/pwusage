'use client';

import { useEffect, useRef, useState } from 'react';

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

function buildTrmnlPreviewDocument(markup: string): string {
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

interface TrmnlLivePreviewProps {
    previewHtml: string;
    previewError: string;
    previewLoading: boolean;
    hasSource: boolean;
    noSourceMessage?: string;
    maxDisplayScale?: number;
    allowNarrowScroll?: boolean;
    showScaleControls?: boolean;
    displayScaleOverride?: number;
}

const TRMNL_SCREEN_WIDTH = 800;
const TRMNL_SCREEN_HEIGHT = 480;
const DISPLAY_SCALE_STORAGE_KEY = 'trmnl_preview_display_scale';
const PRESET_DISPLAY_SCALES = [1, 0.75, 0.5, 0.25] as const;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function TrmnlLivePreview({
    previewHtml,
    previewError,
    previewLoading,
    hasSource,
    noSourceMessage = 'Select a site to load preview.',
    maxDisplayScale = 1,
    allowNarrowScroll = true,
    showScaleControls = true,
    displayScaleOverride
}: TrmnlLivePreviewProps) {
    const normalizedMaxDisplayScale = clamp(maxDisplayScale, 0.2, 1);
    const previewMountRef = useRef<HTMLDivElement | null>(null);
    const previewChassisRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const storageHydratedRef = useRef(false);
    const skipInitialWriteRef = useRef(true);
    const [previewScale, setPreviewScale] = useState(1);
    const [showOverflowHint, setShowOverflowHint] = useState(false);
    const [displayScaleCap, setDisplayScaleCap] = useState(normalizedMaxDisplayScale);
    const effectiveDisplayScaleCap = clamp(displayScaleCap, 0.2, normalizedMaxDisplayScale);
    const resolvedDisplayScaleCap = typeof displayScaleOverride === 'number'
        ? clamp(displayScaleOverride, 0.2, normalizedMaxDisplayScale)
        : effectiveDisplayScaleCap;

    useEffect(() => {
        if (typeof displayScaleOverride === 'number') return;
        if (storageHydratedRef.current) return;
        storageHydratedRef.current = true;

        if (typeof window === 'undefined') return;
        let resolvedScale = normalizedMaxDisplayScale;
        try {
            const raw = window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY);
            if (raw) {
                const parsed = Number(raw);
                if (Number.isFinite(parsed)) {
                    resolvedScale = clamp(parsed, 0.2, normalizedMaxDisplayScale);
                }
            }
        } catch {
            // Ignore localStorage failures.
        }

        if (Math.abs(resolvedScale - displayScaleCap) > 0.001) {
            requestAnimationFrame(() => setDisplayScaleCap(resolvedScale));
        }
    }, [displayScaleCap, displayScaleOverride, normalizedMaxDisplayScale]);

    useEffect(() => {
        if (typeof displayScaleOverride === 'number') return;
        if (!storageHydratedRef.current) return;
        if (skipInitialWriteRef.current) {
            skipInitialWriteRef.current = false;
            return;
        }
        if (typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, effectiveDisplayScaleCap.toFixed(3));
        } catch {
            // Ignore localStorage failures.
        }
    }, [displayScaleOverride, effectiveDisplayScaleCap]);

    useEffect(() => {
        const element = previewMountRef.current;
        if (!element) return;

        const updateScale = () => {
            const cappedScale = resolvedDisplayScaleCap;
            if (allowNarrowScroll) {
                // In scroll mode we don't need chassis measurements;
                // apply persisted/preset scale immediately.
                setPreviewScale(cappedScale);
                return;
            }

            const chassisEl = previewChassisRef.current;
            if (!chassisEl) return;

            const availableWidth = element.clientWidth;
            const naturalWidth = chassisEl.offsetWidth;
            const naturalHeight = chassisEl.offsetHeight;

            if (availableWidth <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return;

            setPreviewScale(Math.max(0.2, Math.min(cappedScale, availableWidth / naturalWidth)));
        };

        updateScale();

        const observer = new ResizeObserver(() => updateScale());
        observer.observe(element);
        return () => observer.disconnect();
    }, [allowNarrowScroll, previewHtml, resolvedDisplayScaleCap]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const updateHint = () => {
            const canScrollX = allowNarrowScroll && container.scrollWidth > container.clientWidth + 1;
            const atStart = container.scrollLeft <= 2;
            setShowOverflowHint(canScrollX && atStart);
        };

        updateHint();
        container.addEventListener('scroll', updateHint, { passive: true });
        const observer = new ResizeObserver(updateHint);
        observer.observe(container);
        return () => {
            container.removeEventListener('scroll', updateHint);
            observer.disconnect();
        };
    }, [allowNarrowScroll, previewHtml, previewScale]);

    return (
        <div className="rounded-lg border bg-zinc-100 dark:bg-slate-900 p-3">
            {showScaleControls && (
            <div className="mb-3 flex items-center justify-end gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>Preview size</span>
                {PRESET_DISPLAY_SCALES.map((scale) => {
                    const enabled = scale <= normalizedMaxDisplayScale;
                    const selected = Math.abs(resolvedDisplayScaleCap - scale) < 0.005;
                    return (
                        <button
                            key={scale}
                            type="button"
                            disabled={!enabled}
                            onClick={() => setDisplayScaleCap(scale)}
                            className={`rounded border px-2 py-1 transition-colors ${selected
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600'
                                } ${enabled ? '' : 'opacity-50 cursor-not-allowed'}`}
                        >
                            {scale === 1 ? 'Full' : `${Math.round(scale * 100)}%`}
                        </button>
                    );
                })}
            </div>
            )}
            {previewError && (
                <div className="mb-3 p-2 bg-red-100 text-red-700 rounded text-sm">
                    Error loading preview: {previewError}
                </div>
            )}
            {previewLoading && !previewHtml && (
                <div className="text-sm text-gray-500 dark:text-gray-400">Loading preview...</div>
            )}
            {!hasSource && (
                <div className="text-sm text-gray-500 dark:text-gray-400">{noSourceMessage}</div>
            )}
            {previewHtml && (
                <div ref={previewMountRef} className="w-full">
                    <div ref={scrollContainerRef} className={`w-full ${allowNarrowScroll ? 'overflow-x-auto' : 'overflow-x-hidden'}`}>
                    <div className="mx-auto w-fit">
                        <div
                            ref={previewChassisRef}
                            className="origin-top-left"
                            style={{ zoom: previewScale }}
                        >
                            <div className="relative rounded-[18px] border border-zinc-700 bg-gradient-to-b from-zinc-600 to-zinc-700 p-4 pb-5 shadow-[0_16px_36px_rgba(0,0,0,0.35)]">
                                <div className="rounded-[12px] border border-zinc-500 bg-zinc-300 p-3 shadow-[inset_0_1px_4px_rgba(0,0,0,0.2)]">
                                    <div className="rounded-[8px] border border-zinc-400 bg-zinc-100 p-2">
                                        <div
                                            className="overflow-hidden rounded border border-gray-300 bg-white"
                                            style={{
                                                width: `${TRMNL_SCREEN_WIDTH}px`,
                                                height: `${TRMNL_SCREEN_HEIGHT}px`,
                                                contain: 'paint'
                                            }}
                                        >
                                            <iframe
                                                title="TRMNL live preview"
                                                className="block border-0 bg-white"
                                                style={{
                                                    width: `${TRMNL_SCREEN_WIDTH}px`,
                                                    height: `${TRMNL_SCREEN_HEIGHT}px`
                                                }}
                                                scrolling="no"
                                                srcDoc={buildTrmnlPreviewDocument(previewHtml)}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-3 text-center text-[11px] font-semibold tracking-[0.2em] text-zinc-300">
                                    TRMNL
                                </div>
                            </div>
                        </div>
                    </div>
                    </div>
                    {showOverflowHint && (
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            Scroll right to view full preview.
                        </p>
                    )}
                </div>
            )}
            <p className="mt-3 text-xs italic text-gray-500 dark:text-gray-400">
                This preview is an approximation. The actual TRMNL device view may look different.
            </p>
        </div>
    );
}
