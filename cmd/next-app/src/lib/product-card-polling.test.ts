import { describe, expect, it, vi } from 'vitest';
import { pollProductCards } from './product-card-polling';

const card = { solarPower: 1, loadPower: 2, batteryPower: 3, gridPower: 4, percentageCharged: 50, stateOfCharge: 50, currentTariff: 'Peak' };

describe('pollProductCards', () => {
    it('polls only energy sites, through the card response', async () => {
        const fetchCard = vi.fn(async () => card);
        const onData = vi.fn();
        await pollProductCards([
            { id: 'a', site_name: 'Home', energy_site_id: '111', type: 'energy' as const },
            { id: 'b', site_name: 'Car', energy_site_id: '222', type: 'vehicle' as const },
            { id: 'c', site_name: 'Unlinked', energy_site_id: 'undefined' },
        ], fetchCard, new AbortController().signal, onData);
        expect(fetchCard).toHaveBeenCalledTimes(1);
        expect(fetchCard).toHaveBeenCalledWith('111', expect.any(AbortSignal));
        expect(onData).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), card);
    });

    it('drops answers after cancellation and keeps a failed card as it was', async () => {
        const controller = new AbortController();
        const onData = vi.fn();
        await pollProductCards([{ id: 'a', site_name: 'Home', energy_site_id: '111' }],
            async () => { controller.abort(); return card; }, controller.signal, onData);
        expect(onData).not.toHaveBeenCalled();

        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await pollProductCards([{ id: 'a', site_name: 'Home', energy_site_id: '111' }],
            async () => { throw new Error('500'); }, new AbortController().signal, onData);
        expect(onData).not.toHaveBeenCalled();
    });
});
