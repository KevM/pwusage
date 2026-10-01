import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { BillDateNav } from './BillDateNav';
afterEach(() => vi.useRealTimers());
describe('billing history navigation limits', () => {
    it('keeps the partial oldest cycle selectable and disables further backward navigation', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T18:00:00Z'));
        const html = renderToStaticMarkup(<BillDateNav siteId="s1" billingDay={15} prevDateStr="2026-05-15" nextDateStr="2026-07-15" isCurrentPeriod={false} dateRangeLabel="Jun 15 - Jul 15" currentMonthVal="2026-06" fullBillDateStr="2026-06-15" earliestDate="2026-07-03" earliestMonth="2026-06" canGoPrevious={false} />);
        expect(html).toContain('value="2026-06"');
        expect(html).not.toContain('value="2026-05"');
        expect(html).not.toContain('usage?date=2026-05-15');
        expect(html).toContain('disabled');
    });
});
