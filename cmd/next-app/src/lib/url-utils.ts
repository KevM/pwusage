import { NextRequest } from 'next/server';

/**
 * Returns the base URL for the application.
 * Priority: 
 * 1. NEXT_PUBLIC_APP_URL environment variable
 * 2. Origin from the provided request (if available)
 * 3. VERCEL_URL environment variable
 * 4. Fallback to http://localhost:5173
 * 
 * @param request Optional request object to extract origin from
 * @returns The base URL without a trailing slash
 */
export function getAppBaseUrl(request?: NextRequest | Request): string {
  let origin: string | undefined;

  if (request) {
    if ('nextUrl' in request) {
      origin = (request as NextRequest).nextUrl.origin;
    } else if ('url' in request) {
      try {
        origin = new URL(request.url).origin;
      } catch {
        // Ignore invalid URLs
      }
    }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 
                  origin || 
                  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:5173");
  
  return baseUrl.replace(/\/$/, '');
}
