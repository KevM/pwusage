import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const PRIVATE_NO_CACHE = 'private, no-cache';
const PRIVATE_NO_STORE = 'private, no-store, max-age=0';

export function computeJsonETag(body: unknown): { serialized: string; etag: string } {
  const serialized = JSON.stringify(body);
  const hash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return { serialized, etag: `"${hash}"` };
}

export function ifNoneMatchMatches(req: NextRequest, etag: string): boolean {
  const header = req.headers.get('if-none-match');
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => {
      if (candidate === '*') return true;
      const normalized = candidate.startsWith('W/') ? candidate.slice(2).trim() : candidate;
      return normalized === etag;
    });
}

export function jsonWithETag(
  body: unknown,
  status = 200,
  cacheControl = PRIVATE_NO_STORE
): NextResponse {
  const { serialized, etag } = computeJsonETag(body);
  return new NextResponse(serialized, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      ETag: etag,
    },
  });
}

export function conditionalTimelineResponse(req: NextRequest, body: unknown): NextResponse {
  const { serialized, etag } = computeJsonETag(body);
  if (ifNoneMatchMatches(req, etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        'Cache-Control': PRIVATE_NO_CACHE,
        ETag: etag,
      },
    });
  }
  return new NextResponse(serialized, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': PRIVATE_NO_CACHE,
      ETag: etag,
    },
  });
}
