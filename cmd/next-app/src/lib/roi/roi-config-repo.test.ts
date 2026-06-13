// roi-config-repo.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
import { pool } from '../db';
import { SiteRoiConfigRepo } from './roi-config-repo';

describe('SiteRoiConfigRepo', () => {
    it('get returns null when no row', async () => {
        (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRoiConfigRepo();
        expect(await repo.get('s1')).toBeNull();
    });
    it('upsert passes all seven columns as params', async () => {
        const q = pool.query as ReturnType<typeof vi.fn>;
        q.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRoiConfigRepo();
        await repo.upsert({ site_id: 's1', solar_cost: 6500, solar_install_date: '2022-01-01',
            battery_cost: 5900, battery_install_date: '2022-01-01', fixed_buy_rate: 0.20, fixed_sell_rate: 0.05 });
        const params = q.mock.calls.at(-1)![1];
        expect(params).toEqual(['s1', 6500, '2022-01-01', 5900, '2022-01-01', 0.20, 0.05]);
    });
});
