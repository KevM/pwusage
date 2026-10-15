export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import {
  APNS_ENVIRONMENTS,
  BatteryHoldActivityRepo,
  ENDED_HOLD_REGISTRATION_WINDOW_MS,
  allowedApnsEnvironments,
  type ApnsEnvironment,
} from '@/lib/battery-hold-activity-repo';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ActivityKit push tokens are hex-encoded.
const PUSH_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){32,256}$/i;

interface ActivityRegistration {
  holdId: number;
  registrationId: string;
  pushToken: string;
  apnsEnvironment: ApnsEnvironment;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
}

function parseRegistration(body: unknown): ActivityRegistration | null {
  if (!body || typeof body !== 'object') return null;
  const { holdId, registrationId, pushToken, apnsEnvironment } = body as Record<string, unknown>;
  if (typeof holdId !== 'number' || !Number.isSafeInteger(holdId) || holdId <= 0) return null;
  if (typeof registrationId !== 'string' || !UUID_PATTERN.test(registrationId)) return null;
  if (typeof pushToken !== 'string' || !PUSH_TOKEN_PATTERN.test(pushToken)) return null;
  if (typeof apnsEnvironment !== 'string' || !(APNS_ENVIRONMENTS as readonly string[]).includes(apnsEnvironment)) return null;
  return { holdId, registrationId, pushToken, apnsEnvironment: apnsEnvironment as ApnsEnvironment };
}

/** Registers or rotates the push token of one Live Activity for a hold on this site. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if (!(await verifySiteAccess(id))) return json({ error: 'Unauthorized' }, 403);

  const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return json({ error: 'Content-Type must be application/json' }, 415);

  const registration = parseRegistration(await req.json().catch(() => null));
  if (!registration) return json({ error: 'invalid_registration' }, 400);
  if (!allowedApnsEnvironments().includes(registration.apnsEnvironment)) {
    return json({ error: 'apns_environment_not_allowed' }, 400);
  }

  const repo = new BatteryHoldActivityRepo();
  try {
    // The session claim can be stale; current DB access decides.
    if (!(await repo.userCanAccessSite(user.id, id))) return json({ error: 'Unauthorized' }, 403);

    // Never trust a client hold id: it must belong to this site.
    const hold = await repo.getHoldForSite(registration.holdId, id);
    if (!hold) return json({ error: 'hold_not_found' }, 404);

    const ended = hold.status !== 'active'
      && (hold.restored_at === null || Date.now() - hold.restored_at.getTime() > ENDED_HOLD_REGISTRATION_WINDOW_MS);
    if (ended) return json({ error: 'hold_ended' }, 410);

    const state = await repo.register({
      holdId: hold.id,
      userId: user.id,
      registrationId: registration.registrationId.toLowerCase(),
      pushToken: registration.pushToken.toLowerCase(),
      apnsEnvironment: registration.apnsEnvironment,
    });
    if (state === null) return json({ error: 'registration_conflict' }, 409);
    if (state === 'disabled') return json({ error: 'registration_disabled' }, 410);

    // Separate call after register, so a completion committed meanwhile is seen.
    await repo.syncDesired(hold.id);
    return json({ status: 'registered', holdStatus: hold.status });
  } catch {
    console.error('[battery-hold-activities] registration failed');
    return json({ error: 'registration_failed' }, 500);
  }
}

/** Removes one registration on dismissal or logout. Deliberately no site-access check. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const registrationId = req.nextUrl.searchParams.get('registrationId');
  if (!registrationId || !UUID_PATTERN.test(registrationId)) return json({ error: 'invalid_registration' }, 400);

  try {
    await new BatteryHoldActivityRepo().remove(user.id, id, registrationId.toLowerCase());
    return json({ status: 'removed' });
  } catch {
    console.error('[battery-hold-activities] removal failed');
    return json({ error: 'removal_failed' }, 500);
  }
}
