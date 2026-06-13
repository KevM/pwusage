import type { RoiSummary } from '@/lib/roi/roi-service';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function ScenarioMatrix({ summary }: { summary: RoiSummary }) {
    const m = summary.matrix;
    const hereFixed = summary.actualPlan === 'fixed'; // actual cell is E (fixed) else F (tou)
    const cell = (label: string, value: number, here: boolean, cheaper: boolean) => (
        <div className={`rounded-lg border p-3 ${here ? 'border-primary bg-primary/10 font-medium' : cheaper ? 'border-green-600 bg-green-600/10 dark:border-green-500 dark:bg-green-950/20' : 'border-gray-200 dark:border-slate-800'}`}>
            <div className="text-xs opacity-70">{label}{here && ' · you are here'}</div>
            <div className="font-semibold">{usd(value)}</div>
        </div>
    );
    return (
        <div className="grid grid-cols-3 gap-2 text-sm">
            <div />
            <div className="text-center text-xs font-semibold opacity-70 flex items-center justify-center">Fixed</div>
            <div className="text-center text-xs font-semibold opacity-70 flex items-center justify-center">TOU</div>

            <div className="flex items-center text-xs font-semibold">No Solar</div>
            {cell('A', m.A, false, false)}{cell('B', m.B, false, false)}

            <div className="flex items-center text-xs font-semibold">Solar</div>
            {cell('C', m.C, false, false)}{cell('D', m.D, false, false)}

            <div className="flex items-center text-xs font-semibold">Solar+Batt</div>
            {cell('E · Fixed', m.E, hereFixed, !hereFixed && m.E < m.F)}
            {cell('F · TOU', m.F, !hereFixed, hereFixed && m.F < m.E)}
        </div>
    );
}
