import { NextRequest, NextResponse } from 'next/server';
import { signSiteToken, COOKIE_MAX_AGE_SECONDS } from '@/lib/auth-jwt';
import { consumeMobileLoginHandoff, isValidMobileLoginExchangeParameters } from '@/lib/mobile-login-handoff';
import { SiteRepo } from '@/lib/site-repo';
import { UserRepo } from '@/lib/user-repo';
import { isSecureRequest } from '@/lib/request-security';

interface ExchangeBody {
  attemptId?: unknown;
  code?: unknown;
  verifier?: unknown;
  state?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return jsonError('Content-Type must be application/json', 415);

  const origin = request.headers.get('origin');
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return jsonError('Cross-origin requests are not allowed', 403);
    }
    if (originUrl.origin !== request.nextUrl.origin) {
      return jsonError('Cross-origin requests are not allowed', 403);
    }
  }

  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    return jsonError('Cross-origin requests are not allowed', 403);
  }

  let body: ExchangeBody;
  try {
    body = await request.json() as ExchangeBody;
  } catch {
    return jsonError('Invalid request', 400);
  }

  if (typeof body.attemptId !== 'string'
    || typeof body.code !== 'string'
    || typeof body.verifier !== 'string'
    || typeof body.state !== 'string'
    || !isValidMobileLoginExchangeParameters(body.attemptId, body.code, body.verifier, body.state)) {
    return jsonError('Invalid request', 400);
  }

  const claims = await consumeMobileLoginHandoff({
    attemptId: body.attemptId,
    code: body.code,
    verifier: body.verifier,
    appState: body.state,
  });
  if (!claims) return jsonError('Login handoff is invalid or expired', 401);

  const user = await new UserRepo().getById(claims.userId);
  if (!user || user.is_active !== true) return jsonError('Account is inactive', 401);

  const currentSites = await new SiteRepo().getSitesForUser(claims.userId);
  const currentSiteIds = new Set(currentSites.map(site => site.id));
  const siteIds = claims.siteIds.filter(siteId => currentSiteIds.has(siteId));
  const roles = user.roles || [];
  if (siteIds.length === 0 && !roles.includes('admin')) {
    return jsonError('No authorized sites remain', 403);
  }

  const siteToken = signSiteToken(siteIds, roles, claims.userId);
  const response = NextResponse.json({ ok: true }, {
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
  response.cookies.set('site_auth', siteToken, {
    httpOnly: true,
    secure: isSecureRequest(request),
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
  });
  return response;
}
