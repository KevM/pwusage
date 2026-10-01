import { validateRetentionDays } from '../src/lib/history-retention';

export type RetentionEnvironment = 'local' | 'dev' | 'prod';
export interface RetentionArgs {
    environment: RetentionEnvironment;
    userId?: string;
    days?: 90 | 365;
    cohort?: string;
    noticeAt?: Date;
    apply: boolean;
}
export function parseRetentionArgs(argv: string[]): RetentionArgs {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (['--apply', '--notice-delivered'].includes(arg)) {
            if (flags.has(arg)) throw new Error(`Duplicate argument ${arg}`);
            flags.add(arg);
        } else if (['--env', '--user', '--days', '--cohort', '--notice-at'].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith('--') || values.has(arg)) throw new Error(`Missing or duplicate ${arg}`);
            values.set(arg, value);
        } else throw new Error(`Unknown argument ${arg}`);
    }
    const environment = values.get('--env');
    if (environment !== 'local' && environment !== 'dev' && environment !== 'prod') throw new Error('Explicit --env local|dev|prod is required');
    const apply = flags.has('--apply');
    const cohort = values.get('--cohort');
    if (cohort) {
        if (values.has('--user') || values.has('--days')) throw new Error('Cohort bootstrap cannot assign individual tiers');
        const notice = values.get('--notice-at');
        if (!notice || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(notice)) throw new Error('An explicit ISO notice timestamp with timezone is required');
        const noticeAt = new Date(notice);
        if (!Number.isFinite(noticeAt.getTime())) throw new Error('Invalid notice date');
        if (apply && !flags.has('--notice-delivered')) throw new Error('Bootstrap apply requires --notice-delivered after actual notice delivery');
        return { environment, cohort, noticeAt, apply };
    }
    if (values.has('--notice-at') || flags.has('--notice-delivered')) throw new Error('Notice arguments require --cohort');
    const userId = values.get('--user');
    if (!userId?.trim() || !values.has('--days')) throw new Error('Explicit --user and --days are required');
    const days = validateRetentionDays(Number(values.get('--days')));
    return { environment, userId, days, apply };
}

/** Validate both direct and Supavisor addresses without printing the connection string. */
export function assertRetentionTarget(environment: RetentionEnvironment, databaseUrl: string | undefined): void {
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    let url: URL;
    try { url = new URL(databaseUrl); } catch { throw new Error('Invalid DATABASE_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database protocol');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const ref = environment === 'dev' ? 'aipxozppjmijrpwyuvuo' : 'gaflounoibsubfoducqz';
    const matches = environment === 'local' ? local :
        url.hostname === `db.${ref}.supabase.co` ||
        (url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username) === `postgres.${ref}`);
    if (!matches) throw new Error('DATABASE_URL does not match the explicit environment');
}


export function parseRetentionAuditArgs(argv: string[]): { environment: RetentionEnvironment; asOf?: Date } {
    if (argv.length !== 2 && argv.length !== 4) throw new Error('Usage: --env local|dev|prod [--as-of ISO-instant]');
    if (argv[0] !== '--env' || !['local', 'dev', 'prod'].includes(argv[1])) throw new Error('Explicit environment is required');
    const environment = argv[1] as RetentionEnvironment;
    if (argv.length === 2) return { environment };
    if (argv[2] !== '--as-of' || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(argv[3])) throw new Error('Invalid audit arguments');
    const asOf = new Date(argv[3]);
    if (!Number.isFinite(asOf.getTime())) throw new Error('Invalid audit date');
    return { environment, asOf };
}
