import { describe, expect, it, vi } from 'vitest';
import {
  buildManageLoginRedirectUrl,
  loadManageInitialData,
  stripManageCredentialsFromUrl,
} from './trmnl-manage-client';

describe('trmnl-manage-client', () => {
  it('strips token, jwt, and handoff from the visible URL while preserving uuid and plugin_setting_id', () => {
    const replaceState = vi.fn();
    const changed = stripManageCredentialsFromUrl(
      'https://pwusage.fm.rodeo/trmnl/manage?uuid=dev-1&token=secret-jwt-1&plugin_setting_id=42',
      replaceState
    );
    expect(changed).toBe(true);
    expect(replaceState).toHaveBeenCalledWith('/trmnl/manage?uuid=dev-1&plugin_setting_id=42');

    const replaceStateJwt = vi.fn();
    stripManageCredentialsFromUrl(
      'https://pwusage.fm.rodeo/trmnl/manage?uuid=dev-1&jwt=secret-jwt-2&handoff=abc',
      replaceStateJwt
    );
    expect(replaceStateJwt).toHaveBeenCalledWith('/trmnl/manage?uuid=dev-1');
  });

  it('never includes token or jwt in emitted API URLs or login redirect URLs during signed-out round trip', async () => {
    const emittedUrls: string[] = [];
    const authHeaders: Array<string | null> = [];
    const redirects: string[] = [];
    const secretToken = 'reusable.trmnl.jwt.secret';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      emittedUrls.push(url);
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get('Authorization'));

      if (url === '/api/sites') {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
      if (url.startsWith('/api/trmnl/manage?')) {
        return new Response(JSON.stringify({ site_id: null }), { status: 200 });
      }
      if (url === '/api/trmnl/manage/handoff') {
        return new Response(JSON.stringify({ handoffId: '11111111-1111-4111-8111-111111111111' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await loadManageInitialData({
      uuid: 'dev-1',
      initialToken: secretToken,
      handoffId: null,
      pluginSettingId: '42',
      fetchImpl: fetchMock,
      onRedirect: (loginUrl) => redirects.push(loginUrl),
    });

    expect(result.redirecting).toBe(true);
    expect(emittedUrls).toEqual([
      '/api/sites',
      '/api/trmnl/manage?uuid=dev-1',
      '/api/trmnl/manage/handoff',
    ]);
    // Token passed in Authorization header, never in any URL
    expect(authHeaders).toContain(`Bearer ${secretToken}`);
    for (const url of emittedUrls) {
      expect(url).not.toContain(secretToken);
      expect(url).not.toContain('token=');
      expect(url).not.toContain('jwt=');
    }

    expect(redirects).toHaveLength(1);
    const redirectUrl = redirects[0];
    expect(redirectUrl).not.toContain(secretToken);
    expect(redirectUrl).not.toContain('token=');
    expect(redirectUrl).not.toContain('jwt=');
    expect(decodeURIComponent(redirectUrl)).toBe(
      '/login?callback=/trmnl/manage?uuid=dev-1&plugin_setting_id=42&handoff=11111111-1111-4111-8111-111111111111'
    );
  });

  it('consumes handoff after login and sends token in Authorization header, never in URL', async () => {
    const emittedUrls: string[] = [];
    const secretToken = 'reusable.trmnl.jwt.secret';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      emittedUrls.push(url);
      if (url === '/api/trmnl/manage/handoff/consume') {
        return new Response(JSON.stringify({ token: secretToken }), { status: 200 });
      }
      if (url === '/api/sites') {
        return new Response(JSON.stringify([{ id: 'site-1', name: 'Home', utility: 'PGE' }]), { status: 200 });
      }
      if (url === '/api/trmnl/manage?uuid=dev-1') {
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe(`Bearer ${secretToken}`);
        return new Response(JSON.stringify({ site_id: 'site-1', plugin_setting_id: 42 }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await loadManageInitialData({
      uuid: 'dev-1',
      initialToken: null,
      handoffId: '11111111-1111-4111-8111-111111111111',
      fetchImpl: fetchMock,
      onRedirect: vi.fn(),
    });

    expect(result.redirecting).toBe(false);
    expect(result.token).toBe(secretToken);
    expect(result.sites).toHaveLength(1);
    expect(result.installData?.site_id).toBe('site-1');
    for (const url of emittedUrls) {
      expect(url).not.toContain(secretToken);
      expect(url).not.toContain('token=');
      expect(url).not.toContain('jwt=');
    }
  });

  it('buildManageLoginRedirectUrl omits handoff for site-authorized management without token', () => {
    const url = buildManageLoginRedirectUrl({ uuid: 'dev-1' });
    expect(decodeURIComponent(url)).toBe('/login?callback=/trmnl/manage?uuid=dev-1');
  });

  it('reaches management for an unlinked device returning from login with one handoff redemption and no re-redirect', async () => {
    const secretToken = 'unlinked.device.jwt';
    let consumeCalls = 0;
    const redirects: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/trmnl/manage/handoff/consume') {
        consumeCalls++;
        return new Response(JSON.stringify({ token: secretToken }), { status: 200 });
      }
      if (url === '/api/sites') {
        return new Response(JSON.stringify([{ id: 'site-1', name: 'Home', utility: 'PGE' }]), { status: 200 });
      }
      if (url === '/api/trmnl/manage?uuid=dev-unlinked') {
        const headers = new Headers(init?.headers);
        if (headers.get('Authorization') !== `Bearer ${secretToken}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        return new Response(JSON.stringify({ site_id: null, component_screens: [] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await loadManageInitialData({
      uuid: 'dev-unlinked',
      initialToken: null,
      handoffId: '22222222-2222-4222-8222-222222222222',
      fetchImpl: fetchMock,
      onRedirect: (u) => redirects.push(u),
    });

    expect(consumeCalls).toBe(1);
    expect(redirects).toEqual([]);
    expect(result.redirecting).toBe(false);
    expect(result.token).toBe(secretToken);
    expect(result.sites).toHaveLength(1);
    expect(result.installData?.site_id).toBeNull();
  });
});
