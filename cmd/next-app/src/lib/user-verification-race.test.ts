import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, logEvent } = vi.hoisted(() => ({ query: vi.fn(), logEvent: vi.fn() }));
vi.mock('./db', () => ({ pool: { query } }));
vi.mock('./observability', () => ({ logEvent, flushLogEvents: vi.fn() }));
import { UserRepo } from './user-repo';
import { TeslaAuthError, type EnergySiteLiveStatus } from './tesla-client';

const liveStatus: EnergySiteLiveStatus = {
    percentage_charged: 50, solar_power: 0, backup_capable: true,
    battery_power: 0, load_power: 0, grid_status: 'Active',
    grid_services_active: false, grid_power: 0, grid_services_power: 0,
    generator_power: 0, island_status: 'on_grid', storm_mode_active: false,
    timestamp: '2026-10-27T12:00:00Z',
};

describe('account verification races', () => {
    let state: { auth_version: string; auth_status: string; is_active: boolean; last_checked_at: string | null };
    let hasSite: boolean;
    let committed: number;

    function changeStatus(status: string, active: boolean) {
        state = { ...state, auth_version: String(Number(state.auth_version) + 1), auth_status: status, is_active: active };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        state = { auth_version: '100', auth_status: 'active', is_active: true, last_checked_at: null };
        hasSite = true;
        committed = 0;
        query.mockImplementation(async (sql: string, values: unknown[]) => {
            if (sql.startsWith('SELECT id FROM "Site"')) return { rows: hasSite ? [{ id: 'site-1' }] : [] };
            if (sql.trimStart().startsWith('SELECT')) return { rows: [{ ...state }] };
            if (sql.includes('SET auth_status = $1')) {
                if (sql.includes('xmin::text') && (values[3] !== state.auth_version
                    || (values[4] && !hasSite) || (values[0] === 'no_sites' && hasSite))) {
                    return { rowCount: 0, rows: [] };
                }
                committed++;
                changeStatus(String(values[0]), values[1] === true);
                state.last_checked_at = 'checked';
                return { rowCount: 1, rows: [] };
            }
            throw new Error('Unexpected verification SQL');
        });
    });

    it('does not let an old terminal failure disable a newer login', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                changeStatus('active', true); // login saved new credentials
                throw new TeslaAuthError('Old credential rejected');
            } }),
        });
        expect(state.is_active).toBe(true);
        expect(state.auth_status).toBe('active');
        expect(committed).toBe(0);
        expect(result).toEqual({ status: 'active' });
        expect(logEvent).toHaveBeenCalledWith('info', 'tesla.user-verification.superseded', expect.objectContaining({
            attemptedOutcome: 'revoked', currentAuthStatus: 'active', siteId: 'site-1', verificationId: expect.any(String),
        }));
    });

    it.each(['success', 'transient'])('does not let a late %s reactivate a newer revocation', async outcome => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                changeStatus('revoked', false);
                if (outcome === 'transient') throw new Error('Tesla unavailable');
                return liveStatus;
            } }),
        });
        expect(state.is_active).toBe(false);
        expect(state.auth_status).toBe('revoked');
        expect(committed).toBe(0);
        expect(result).toEqual({ status: 'revoked' });
    });

    it('does not mark credentials missing when a login completes during client construction', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => { changeStatus('active', true); return null; },
        });
        expect(state.is_active).toBe(true);
        expect(committed).toBe(0);
        expect(result.status).toBe('active');
    });

    it('does not count a newer disabled account as active when its status label still says active', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                changeStatus('active', false);
                return liveStatus;
            } }),
        });
        expect(result.status).toBe('inactive');
        expect(committed).toBe(0);
    });

    it('treats a refresh performed during verification as newer state', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                changeStatus('active', true); // shared refresh changed the row
                return liveStatus;
            } }),
        });
        expect(committed).toBe(0);
        expect(state.last_checked_at).toBeNull();
        expect(result.status).toBe('active');
    });

    it('does not apply a successful check after the site is assigned to somebody else', async () => {
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => ({ getLiveStatus: async () => {
                hasSite = false;
                return liveStatus;
            } }),
        });
        expect(committed).toBe(0);
        expect(result.status).toBe('active');
    });

    it('does not deactivate a no-site account if a site is linked before the write', async () => {
        hasSite = false;
        const implementation = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values: unknown[]) => {
            if (sql.startsWith('SELECT id FROM "Site"')) {
                hasSite = true;
                return { rows: [] }; // lookup completed just before linking
            }
            return implementation(sql, values);
        });
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' });
        expect(committed).toBe(0);
        expect(state.is_active).toBe(true);
        expect(result.status).toBe('active');
    });

    it.each(['success', 'terminal', 'transient', 'no-token', 'no-sites'] as const)('still applies an unchanged %s result', async outcome => {
        hasSite = outcome !== 'no-sites';
        const result = await new UserRepo().verifyUserStatus({ id: 'u1' }, {
            createClient: async () => outcome === 'no-token' ? null : { getLiveStatus: async () => {
                if (outcome === 'terminal') throw new TeslaAuthError('Rejected');
                if (outcome === 'transient') throw new Error('Tesla unavailable');
                return liveStatus;
            } },
        });
        const expected = { success: 'active', terminal: 'revoked', transient: 'error', 'no-token': 'no_token', 'no-sites': 'no_sites' }[outcome];
        expect(result.status).toBe(expected);
        expect(committed).toBe(1);
        expect(state.last_checked_at).toBe('checked');
    });
});
