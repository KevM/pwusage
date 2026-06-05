import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserMock, redirectMock, headersMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  redirectMock: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
  headersMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: getUserMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));

import ContinuePage from './page';

const props = (to?: string) => ({ searchParams: Promise.resolve({ to }) }) as never;

describe('ContinuePage', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    headersMock.mockReset();
    redirectMock.mockClear();
    headersMock.mockResolvedValue({ get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1' });
  });

  it('forwards a signed-in visitor to the validated target', async () => {
    getUserMock.mockResolvedValue({ id: 'u1' });
    await expect(ContinuePage(props('/site/1/live?action=park'))).rejects.toThrow('REDIRECT:/site/1/live?action=park');
  });

  it('forwards to / when the target is an open-redirect attempt', async () => {
    getUserMock.mockResolvedValue({ id: 'u1' });
    await expect(ContinuePage(props('//evil.com'))).rejects.toThrow('REDIRECT:/');
  });

  it('renders the gate (no redirect) for an unauthenticated visitor', async () => {
    getUserMock.mockResolvedValue(null);
    const el = await ContinuePage(props('/site/1/live?action=park'));
    expect(el).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
