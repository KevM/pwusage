'use client';

import { useState } from 'react';
import { LOAD_PROFILES, MAX_PROFILE_KWH, type LoadProfile } from '@/lib/load-profiles';
import { buildRunLoadTiles } from '@/lib/run-load-view';
import type { LoadTimingPeriod } from '@/lib/load-timing';

export interface RunLoadNowWidgetProps {
    periods: LoadTimingPeriod[];
}

export function RunLoadNowWidget({ periods }: RunLoadNowWidgetProps) {
    const initial = LOAD_PROFILES[LOAD_PROFILES.length - 1] ?? null;
    const [selected, setSelected] = useState<LoadProfile | null>(initial);
    const [loadKwh, setLoadKwh] = useState<number>(initial?.kwh ?? 5);

    if (periods.length === 0) return null;

    const tiles = buildRunLoadTiles(periods, loadKwh, selected?.headroomKwh);

    return (
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-medium text-foreground">Can I run this now?</p>

            {/* Presets wrap: the profile list is expected to grow. */}
            <div className="mt-3 flex flex-wrap gap-2">
                {LOAD_PROFILES.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => { setSelected(p); setLoadKwh(p.kwh); }}
                        className={`rounded-full border px-3 py-1 text-xs ${
                            selected?.id === p.id
                                ? 'border-blue-500 text-blue-700 dark:text-blue-400'
                                : 'border-slate-200 text-gray-600 dark:border-slate-700 dark:text-gray-300'
                        }`}
                    >
                        {p.label} <span className="text-gray-400">{p.kwh} kWh</span>
                    </button>
                ))}
            </div>

            <label className="mt-3 block">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    Load size: {loadKwh} kWh
                </span>
                <input
                    type="range"
                    min={1}
                    max={MAX_PROFILE_KWH}
                    step={1}
                    value={loadKwh}
                    onChange={(e) => { setSelected(null); setLoadKwh(Number(e.target.value)); }}
                    className="mt-1 w-full"
                />
            </label>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((t) => (
                    <div key={t.name} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t.name} · {t.whenLabel}
                        </p>
                        <p className={`text-xl font-semibold ${t.toneClass}`}>{t.costLabel}</p>
                        {/* The bar always reports the exact sell/buy split, even
                            when the verdict is softened to "tight". */}
                        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-red-500">
                            <div className="bg-green-500" style={{ width: `${t.barCoveredPct}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
