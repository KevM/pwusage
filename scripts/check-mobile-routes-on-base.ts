/**
 * Guards the deployment gap that hid a real failure: the app called a route that
 * only existed on a feature branch, so production answered 404 and the app
 * misreported the cause. A route the app depends on must exist on the base
 * branch before that branch is the thing being deployed or tested.
 *
 * Usage: npx tsx scripts/check-mobile-routes-on-base.ts [baseRef]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const APP_API = 'cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift';
const WEB_APP = 'cmd/next-app';

/** Endpoints the iOS app calls, mapped to the web route that serves each. */
const REQUIRED_ROUTES = [
    '/api/mobile/session',
    '/api/mobile/bill-summary',
    '/api/mobile/load-planning-context',
    '/api/site-live-data',
    '/api/sites',
];

function routeFile(route: string): string {
    return path.join(WEB_APP, 'src', 'app', route.replace(/^\//, ''), 'route.ts');
}

function existsOnRef(ref: string, route: string): boolean {
    const file = routeFile(route);
    if (!existsSync(file)) return false;
    try {
        execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function main(): void {
    const baseRef = process.argv[2] ?? 'origin/main';
    const workingCopy = existsSync(APP_API);
    if (!workingCopy) {
        console.error(`Run this from the repository root; ${APP_API} not found.`);
        process.exit(1);
    }

    let refExists = true;
    try {
        execFileSync('git', ['rev-parse', '--verify', baseRef], { stdio: 'ignore' });
    } catch {
        refExists = false;
    }

    console.log(`Checking iOS routes against ${refExists ? baseRef : 'HEAD (no base ref found)'}\n`);
    const missing: string[] = [];
    for (const route of REQUIRED_ROUTES) {
        const target = refExists ? baseRef : 'HEAD';
        const present = existsOnRef(target, route);
        if (present) {
            console.log(`  ok      ${route}`);
        } else {
            console.log(`  MISSING ${route}  (not on ${target})`);
            missing.push(route);
        }
    }

    if (missing.length > 0) {
        console.log(`\n${missing.length} route(s) the app calls are absent from ${refExists ? baseRef : 'HEAD'}.`);
        console.log('A device build against a deployment without these will get a 404 and fall back to the basic estimator.');
        process.exit(1);
    }
    console.log('\nAll app routes are present.');
}

main();
