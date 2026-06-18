import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import { ScheduleEditor } from './ScheduleEditor';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

const flatWindow = {
    name: 'Flat', buy_rate: 0.3, sell_rate: 0.05,
    from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
};
const flat: ParsedSeason[] = [{
    name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
    buy_rate: 0.3, sell_rate: 0.05, schedules: [flatWindow],
}];
const gapped: ParsedSeason[] = [{ ...flat[0], schedules: [{ ...flatWindow, from_hour: 6, to_hour: 22 }] }];

function render(seasons: ParsedSeason[]) {
    return renderToStaticMarkup(
        <ScheduleEditor
            name="" nameLocked={false} effectiveFrom=""
            initialSeasons={seasons}
            onSave={async () => true} onCancel={() => {}}
        />,
    );
}

describe('ScheduleEditor', () => {
    it('renders the season and a window row from the seed', () => {
        const html = render(flat);
        expect(html).toContain('All Year');
        expect(html).toMatch(/0\.3/);     // window buy rate
        expect(html).toMatch(/Mon/);      // day label
    });

    it('a fully-covered flat seed reports no gaps and enables Save', () => {
        const html = render(flat);
        expect(html).not.toContain('data-gap="true"');
        expect(html).toContain('data-disabled="false"');
    });

    it('a gapped seed lights the heatmap red and disables Save', () => {
        const html = render(gapped);
        expect(html).toContain('data-gap="true"');
        expect(html).toContain('data-disabled="true"');
    });
});
