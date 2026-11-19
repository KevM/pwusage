import { NextRequest, NextResponse } from 'next/server';
import { isCrossOriginRequest, isSecureRequest } from '@/lib/request-security';
import {
  consumeTrmnlManageHandoff,
  TRMNL_MANAGE_BINDING_COOKIE,
} from '@/lib/trmnl-manage-handoff';

export async function POST(req: NextRequest) {
  if (isCrossOriginRequest(req)) {
    return NextResponse.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }
  const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const body = await req.json().catch(() => null) as { handoffId?: unknown; uuid?: unknown } | null;
  const handoffId = typeof body?.handoffId === 'string' ? body.handoffId.trim() : '';
  const uuid = typeof body?.uuid === 'string' ? body.uuid.trim() : '';
  const browserBinding = req.cookies.get(TRMNL_MANAGE_BINDING_COOKIE)?.value ?? '';

  if (!handoffId || !uuid) {
    return NextResponse.json({ error: 'Missing handoffId or uuid' }, { status: 400 });
  }

  const token = browserBinding
    ? await consumeTrmnlManageHandoff({ handoffId, deviceUuid: uuid, browserBinding })
    : null;

  const res = token
    ? NextResponse.json({ token }, { headers: { 'Cache-Control': 'no-store' } })
    : NextResponse.json({ error: 'Invalid or expired handoff' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

  res.cookies.set(TRMNL_MANAGE_BINDING_COOKIE, '', {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
