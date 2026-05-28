import { track } from './analytics';

// Dedup within the current page session to avoid spamming the event
// when multiple components hit a revoked Tesla token in parallel.
let fired = false;

export function notifyReauthNeeded(siteId?: string): void {
    if (fired) return;
    fired = true;
    const props: Record<string, string> = {};
    if (siteId) props.site_id = siteId;
    track('tesla-reauth-needed', props);
}

// Test-only — not exported from the public surface of the lib.
export function __resetReauthSignal(): void {
    fired = false;
}
