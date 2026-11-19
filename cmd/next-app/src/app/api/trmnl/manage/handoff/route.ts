import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';
import { verifyTrmnlToken } from '@/lib/trmnl-auth';
import {
  createTrmnlManageHandoff,
  TRMNL_MANAGE_BINDING_COOKIE,
  TRMNL_MANAGE_HANDOFF_TTL_SECONDS,
} from '@/lib/trmnl-manage-handoff';

export async function POST(req: NextRequest) {
  if (isCrossOriginRequest(req)) {
    return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }
  const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const body = await req.json().catch(() => null) as { uuid?: unknown; token?: unknown } | null;
  const uuid = typeof body?.uuid === 'string' ? body.uuid.trim() : '';
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!uuid || !token) {
    return NextResponse.json({ error: 'Missing uuid or token' }, { status: 400 });
  }

  try {
    await verifyTrmnlToken(token, uuid);
  } catch {
    return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
  }

  const { handoffId, browserBinding } = await createTrmnlManageHandoff({
    deviceUuid: uuid,
    trmnlToken: token,
  });

  const res = NextResponse.json(
    { handoffId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  res.cookies.set(TRMNL_MANAGE_BINDING_COOKIE, browserBinding, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: TRMNL_MANAGE_HANDOFF_TTL_SECONDS,
  });
  return res;
}
