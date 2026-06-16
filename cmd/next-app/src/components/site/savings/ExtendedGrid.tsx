import { Fragment } from 'react';
import type { ColumnType, ExtendedGridModel, GridCell } from '@/lib/roi/extended-grid';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const typeLabel = (t: ColumnType) => (t === 'metered' ? 'metered' : t === 'fixed' ? 'Fixed' : 'TOU');

function cellClasses(cell: GridCell): string {
    if (cell.here) return 'border-primary bg-primary/10 font-medium';
    if (cell.cheapest) return 'border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20';
    return 'border-gray-200 dark:border-slate-800';
}

export function ExtendedGrid({ grid }: { grid: ExtendedGridModel }) {
    const cols = grid.columns;
    return (
        <>
            {/* Desktop: sticky config column + horizontal scroll on overflow */}
            <div className="hidden md:block overflow-x-auto">
                <div
                    className="grid gap-2 text-sm min-w-max"
                    style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(7rem, 1fr))` }}
                >
                    <div className="sticky left-0 z-10 bg-bg-base" />
                    {cols.map((c, i) => (
                        <div key={i} className="text-center text-xs font-semibold opacity-70 flex flex-col items-center justify-center">
                            <span>{c.name}</span>
                            <span className="font-normal opacity-80">
                                {typeLabel(c.type)}{c.type === 'metered' && ' · you are here'}
                            </span>
                        </div>
                    ))}
                    {grid.rows.map(row => (
                        <Fragment key={row.config}>
                            <div className="sticky left-0 z-10 bg-bg-base flex items-center text-xs font-semibold pr-2">
                                {row.label}
                            </div>
                            {row.cells.map((cell, i) => (
                                <div key={i} className={`rounded-lg border p-3 ${cellClasses(cell)}`}>
                                    <div className="font-semibold">{usd(cell.value)}</div>
                                </div>
                            ))}
                        </Fragment>
                    ))}
                </div>
            </div>

            {/* Mobile: transpose to one card per plan */}
            <div className="md:hidden space-y-3">
                {cols.map((c, ci) => (
                    <div key={ci} className={`rounded-lg border p-3 ${c.type === 'metered' ? 'border-primary bg-primary/10' : 'border-gray-200 dark:border-slate-800'}`}>
                        <div className="text-xs font-semibold opacity-70 mb-2">
                            {c.name} · {typeLabel(c.type)}{c.type === 'metered' && ' · you are here'}
                        </div>
                        <div className="space-y-1">
                            {grid.rows.map(row => {
                                const cell = row.cells[ci];
                                return (
                                    <div key={row.config} className="flex justify-between text-sm">
                                        <span className="opacity-70">{row.label}</span>
                                        <span className={`font-semibold ${cell.cheapest ? 'text-green-600 dark:text-green-500' : ''}`}>
                                            {usd(cell.value)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}
